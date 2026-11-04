"""Catálogo determinístico das aplicações de escala do lab (40 por padrão), compartilhado entre
scale_app.py (tráfego OTLP) e scale_hosts.py (hosts, itens e triggers no Zabbix).

Cada aplicação tem um serviço de entrada (`<app>-web`, `-portal`, `-api` ou `-app`) que chama 2 ou 3
serviços internos (`<app>-<papel>`); cada serviço tem um banco (db.system) e, às vezes, uma chamada
externa (server.address) ou uma chamada a outro serviço interno. Duas plataformas compartilhadas
(`platform-auth` e `platform-notify`) são usadas por parte das aplicações, para testar serviços que
pertencem a mais de uma aplicação. Tudo sai de random.Random com semente fixa: a mesma lista sempre.
"""

import random

APPS = [
    "seguradora", "telecom", "varejo-online", "saude-digital", "educacao", "turismo", "imobiliaria", "games",
    "delivery", "fintech", "farmacia", "supermercado", "academia", "petshop", "moda", "eletro", "livraria",
    "cinema", "musica", "podcast", "agro", "energia", "agua", "transporte", "estacionamento", "hotel",
    "restaurante", "cartorio", "prefeitura", "universidade", "hospital", "laboratorio", "clinica", "advocacia",
    "contabilidade", "construtora", "mineradora", "siderurgia", "cosmeticos", "brinquedos",
]
ENTRY_SUFFIX = ["web", "portal", "api", "app"]
ROLES = ["auth", "catalog", "orders", "payments", "search", "notifications", "users", "inventory", "billing",
         "reports", "pricing", "ledger", "scheduler", "profile", "media", "geo", "fraud", "recommendation",
         "messaging", "documents"]
# (db.system, intervalo normal em s, intervalo lento em s, mensagem de erro)
DATABASES = [
    ("postgresql", (0.01, 0.05), (0.5, 1.1), "timeout no PostgreSQL"),
    ("mysql", (0.01, 0.05), (0.5, 1.0), "timeout no MySQL"),
    ("redis", (0.001, 0.005), (0.2, 0.5), "redis indisponível"),
    ("mongodb", (0.01, 0.04), (0.5, 1.0), "timeout no MongoDB"),
    ("cassandra", (0.02, 0.06), (0.6, 1.2), "timeout no Cassandra"),
    ("oracle", (0.02, 0.07), (0.6, 1.3), "ORA-12170: timeout"),
]
EXTERNALS = [
    ("api.pagamentos.lab", (0.05, 0.15), (0.8, 1.5), "gateway recusou"),
    ("api.correios.lab", (0.04, 0.12), (0.7, 1.4), "correios não respondeu"),
    ("api.sms.lab", (0.04, 0.10), (0.8, 1.5), "provedor de SMS falhou"),
    ("api.mapas.lab", (0.04, 0.10), (0.6, 1.2), "mapas indisponível"),
    ("s3.lab", (0.02, 0.07), (0.8, 1.6), "objeto não encontrado"),
    ("api.receita.lab", (0.06, 0.18), (0.9, 1.8), "receita fora do ar"),
    ("api.serasa.lab", (0.05, 0.14), (0.8, 1.5), "consulta negada"),
    ("ldap.lab", (0.02, 0.06), (0.6, 1.2), "LDAP indisponível"),
    ("kafka.lab", (0.005, 0.02), (0.5, 1.1), "broker indisponível"),
]
PLATFORM = {
    "platform-auth": {"route": "POST /validate", "db": DATABASES[2], "external": EXTERNALS[7], "share": 3},
    "platform-notify": {"route": "POST /notify", "db": DATABASES[0], "external": EXTERNALS[2], "share": 4},
}


def _service(name, namespace, route, db, external=None, calls=(), internal=None, entry=False):
    return {"name": name, "namespace": namespace, "route": route, "db": db, "external": external,
            "calls": list(calls), "internal": internal, "entry": entry}


def catalog(count=len(APPS)):
    """Devolve {"apps": [{id, services:[nomes], entry}], "services": {nome: definição}}."""
    services, apps = {}, []
    for pname, p in PLATFORM.items():
        services[pname] = _service(pname, "platform", p["route"], p["db"], p["external"],
                                   internal=("token.verify" if pname == "platform-auth" else "template.render"))
    for i, app in enumerate(APPS[:count]):
        rnd = random.Random(f"sd:{app}")
        entry = f"{app}-{rnd.choice(ENTRY_SUFFIX)}"
        roles = rnd.sample(ROLES, rnd.choice([2, 3]))
        backends = [f"{app}-{r}" for r in roles]
        for role, name in zip(roles, backends):
            ext = rnd.choice(EXTERNALS) if rnd.random() < 0.4 else None
            services[name] = _service(name, app, f"POST /{role}", rnd.choice(DATABASES), ext,
                                      internal=f"{role}.process")
        # Metade das aplicações tem uma cadeia: um interno chama outro interno.
        if len(backends) >= 2 and rnd.random() < 0.5:
            a, b = rnd.sample(backends, 2)
            services[a]["calls"].append(b)
        calls = list(backends)
        for pname, p in PLATFORM.items():
            if i % p["share"] == 0:
                calls.append(pname)
        services[entry] = _service(entry, app, "GET /home", rnd.choice(DATABASES[:3]), None, calls,
                                   internal="session.check", entry=True)
        apps.append({"id": app, "entry": entry, "services": [entry, *backends]})
    return {"apps": apps, "services": services}


def estimated_p95(services, name, _depth=0):
    """Latência esperada (s) de uma requisição ao serviço: soma dos passos próprios e dos chamados."""
    s = services[name]
    total = s["db"][1][1] + (s["external"][1][1] if s["external"] else 0) + 0.01
    if _depth < 5:
        total += sum(estimated_p95(services, c, _depth + 1) for c in s["calls"])
    return total


def p95_limit(services, name):
    """Limite da macro {$APM.P95.MAX}: 3 vezes o esperado, mínimo 0,2 s, arredondado a 0,1."""
    return max(0.2, round(3 * estimated_p95(services, name), 1))


if __name__ == "__main__":
    import sys
    cat = catalog(int(sys.argv[1]) if len(sys.argv) > 1 else len(APPS))
    svcs = cat["services"]
    externals = sum(1 for s in svcs.values() if s["external"])
    chains = sum(len(s["calls"]) for s in svcs.values() if not s["entry"])
    for app in cat["apps"]:
        shared = [c for c in svcs[app["entry"]]["calls"] if c.startswith("platform-")]
        extra = f" + {', '.join(shared)}" if shared else ""
        print(f"{app['id']:16} {app['entry']:24} -> {', '.join(app['services'][1:])}{extra}  "
              f"(p95 max {p95_limit(svcs, app['entry'])} s)")
    print(f"{len(cat['apps'])} aplicações, {len(svcs)} serviços, {len(svcs)} bancos, {externals} externos, "
          f"{chains} cadeias internas")
