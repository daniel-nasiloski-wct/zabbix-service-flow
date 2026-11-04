"""Tráfego OTLP de escala para o lab: 40 aplicações (scale_catalog.py) com ~140 serviços, para testar o
APM dashboard com muitos cards, muitos hosts e dezenas de milhares de spans na janela.

Cada aplicação roda numa thread própria e faz uma requisição na entrada a cada --interval segundos; a
entrada chama cada serviço interno com 70 % de chance (mais as plataformas compartilhadas), cada serviço
consulta o banco dele e, quando tem, a dependência externa. Envia traces e logs (as métricas OTel não são
usadas pelos itens nem pelo mapa, então ficam de fora para poupar conexões). Com --incidents N, N serviços
sorteados ficam lentos ou com erros durante toda a execução.

Uso (da raiz do Zabbix_telemetry, com o venv que já tem o SDK OTel):
    .venv/bin/python zabbix-service-flow/tests/lab/scale_app.py [--endpoint http://localhost:4317]
        [--apps 40] [--iterations 150] [--interval 6] [--incidents 2]
Com --iterations 0 roda até Ctrl-C. Os hosts no Zabbix vêm do scale_hosts.py.
"""

import argparse
import logging
import random
import threading
import time

from opentelemetry import context
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode

from scale_catalog import catalog

MODES = ["latency", "errors"]
CALL_PROBABILITY = 0.7


class Failure(Exception):
    pass


class Service:
    def __init__(self, spec, endpoint):
        self.spec = spec
        self.name = spec["name"]
        resource = Resource.create({"service.name": self.name, "service.namespace": spec["namespace"],
                                    "service.version": "1.0.0", "deployment.environment": "lab",
                                    "host.name": "scale-app"})
        self.tp = TracerProvider(resource=resource)
        self.tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=True)))
        self.tracer = self.tp.get_tracer(f"{self.name}.tracer", "1.0.0")
        self.lp = LoggerProvider(resource=resource)
        self.lp.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint, insecure=True)))
        self.log = logging.getLogger(self.name)
        self.log.setLevel(logging.INFO)
        self.log.propagate = False
        self.log.addHandler(LoggingHandler(level=logging.INFO, logger_provider=self.lp))
        self.incident = None  # None, "latency" ou "errors"

    def flush(self):
        self.tp.force_flush()
        self.lp.force_flush()

    def shutdown(self):
        self.tp.shutdown()
        self.lp.shutdown()


class Simulation:
    def __init__(self, cat, endpoint):
        self.services = {name: Service(spec, endpoint) for name, spec in cat["services"].items()}
        self.apps = cat["apps"]

    def step(self, svc, name, kind, normal, slow, fail_rate, error_msg, attrs=None, degradable=True):
        """Um span filho: dorme no intervalo normal (ou lento, em incidente) e falha com fail_rate."""
        with svc.tracer.start_as_current_span(name, kind=kind, attributes=attrs or {}) as span:
            low, high = slow if degradable and svc.incident == "latency" else normal
            time.sleep(random.uniform(low, high))
            if degradable and svc.incident == "errors":
                fail_rate = 0.8
            if random.random() < fail_rate:
                span.set_status(Status(StatusCode.ERROR, error_msg))
                raise Failure(f"{name}: {error_msg}")

    def serve(self, svc):
        """Span SERVER de uma requisição ao serviço: passo interno, chamadas a outros, banco e externo.

        O passo interno nunca degrada e as chamadas vêm antes do banco: assim um incidente na entrada
        não deixa os serviços internos sem tráfego (o que os faria parecer aplicações à parte no mapa).
        """
        spec = svc.spec
        route = spec["route"]
        start = time.perf_counter()
        with svc.tracer.start_as_current_span(route, kind=SpanKind.SERVER,
                                              attributes={"http.route": route}) as span:
            failed = None
            try:
                self.step(svc, spec["internal"], SpanKind.INTERNAL, (0.002, 0.01), (0.3, 0.7), 0.005,
                          "falha interna", degradable=False)
                for callee in spec["calls"]:
                    if spec["entry"] and random.random() > CALL_PROBABILITY:
                        continue
                    self.call(svc, callee)
                db, normal, slow, msg = spec["db"]
                self.step(svc, "db.query", SpanKind.CLIENT, normal, slow, 0.01, msg, {"db.system": db})
                if spec["external"]:
                    host, normal, slow, msg = spec["external"]
                    self.step(svc, "http.request", SpanKind.CLIENT, normal, slow, 0.02, msg, {"server.address": host})
                status = 200
            except Failure as e:
                status, failed = 500, e
            span.set_attribute("http.response.status_code", status)
            if failed:
                span.set_status(Status(StatusCode.ERROR, str(failed)))
                svc.log.error("%s falhou: %s", route, failed)
            else:
                svc.log.info("%s concluída", route)
            elapsed_ms = (time.perf_counter() - start) * 1000
            if elapsed_ms > 500:
                svc.log.warning("%s lenta: %.0f ms", route, elapsed_ms)
        if failed:
            raise failed

    def call(self, caller, callee_name):
        """Span CLIENT no chamador envolvendo a requisição ao outro serviço."""
        callee = self.services[callee_name]
        with caller.tracer.start_as_current_span(f"{callee_name}.call", kind=SpanKind.CLIENT,
                                                 attributes={"peer.service": callee_name}) as span:
            try:
                self.serve(callee)
            except Failure:
                span.set_status(Status(StatusCode.ERROR, f"{callee_name} falhou"))
                raise

    def request(self, entry):
        token = context.attach(context.Context())
        try:
            self.serve(self.services[entry])
        except Failure:
            pass
        finally:
            context.detach(token)

    def run_app(self, app, iterations, interval, stop):
        time.sleep(random.uniform(0, interval))  # espalha as aplicações dentro do intervalo
        i = 0
        while not stop.is_set() and (iterations == 0 or i < iterations):
            self.request(app["entry"])
            i += 1
            stop.wait(interval * random.uniform(0.8, 1.2))

    def shutdown(self):
        for svc in self.services.values():
            svc.flush()
        for svc in self.services.values():
            svc.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://localhost:4317", help="proxy APM do lab")
    parser.add_argument("--apps", type=int, default=40)
    parser.add_argument("--iterations", type=int, default=150, help="requisições por aplicação; 0 = sem fim")
    parser.add_argument("--interval", type=float, default=6.0, help="segundos entre requisições de cada aplicação")
    parser.add_argument("--incidents", type=int, default=0, help="quantos serviços ficam lentos ou com erros")
    args = parser.parse_args()

    cat = catalog(args.apps)
    sim = Simulation(cat, args.endpoint)
    print(f"{len(cat['apps'])} aplicações, {len(cat['services'])} serviços, {args.interval:g} s entre requisições "
          f"por aplicação, {'sem fim' if args.iterations == 0 else f'{args.iterations} iterações'}", flush=True)
    for name in random.sample(sorted(sim.services), min(args.incidents, len(sim.services))):
        sim.services[name].incident = random.choice(MODES)
        kind = "latência alta" if sim.services[name].incident == "latency" else "erros"
        print(f"Incidente: {name} com {kind}", flush=True)

    stop = threading.Event()
    threads = [threading.Thread(target=sim.run_app, args=(app, args.iterations, args.interval, stop), daemon=True)
               for app in cat["apps"]]
    for t in threads:
        t.start()
    started = time.time()
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(30)
            alive = sum(t.is_alive() for t in threads)
            print(f"{time.strftime('%H:%M:%S')} {int(time.time() - started)} s, {alive} aplicações ativas", flush=True)
    except KeyboardInterrupt:
        print("encerrando…", flush=True)
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=5)
        sim.shutdown()


if __name__ == "__main__":
    main()
