"""Prepara o Zabbix do lab para o módulo APM dashboard.

Faz, de forma idempotente (pode rodar de novo):
  - fonte de dados global de APM apontando para o ClickHouse do lab;
  - proxy ativo "sdlab-proxy" com coleta de APM habilitada (abre a porta 4317 no container do proxy);
  - grupo "apps" e um host por serviço do multi_app.py (17), cada um com 3 itens Telemetry query,
    4 dependentes (apm.requests, apm.latency.p95, apm.errors, apm.logs.error), macros e 4 triggers,
    iguais aos da VM .100 (mesma lógica do apm_hosts.py, mas criando do zero);
  - um usuário comum "viewer" (role "APM dashboard viewer", tipo User) só com leitura do grupo "apps",
    para testar permissões.

Uso: python3 seed.py [--url http://localhost:8080/zabbix/api_jsonrpc.php] [--user Admin] [--password zabbix]
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

GROUP = "apps"
PROXY = "sdlab-proxy"
CLICKHOUSE = {"url": "http://clickhouse:8123", "db": "zabbix", "username": "zabbix", "password": "zabbix"}

# Limites por serviço (p95 em segundos), 2 a 4 vezes o p95 normal do multi_app.py --interval 2.
P95_MAX = {
    "checkout-demo": 0.6, "catalog-api": 0.3, "auth-service": 0.2, "payment-gateway": 0.4, "shipping-service": 0.4,
    "bank-portal": 0.6, "account-service": 0.3, "fraud-engine": 0.3, "notification-service": 0.4,
    "stream-hub": 0.4, "entitlement-service": 0.2, "media-service": 0.4, "recommendation-service": 0.3,
    "fleet-tracker": 0.6, "telemetry-ingest": 0.2, "routing-engine": 0.6, "traffic-service": 0.3,
}
ERRORS_MAX = 5
LOGS_MAX = 5

ITEM_TYPE_TELEMETRY_QUERY, ITEM_TYPE_DEPENDENT = 24, 18
VALUE_FLOAT, VALUE_JSON = 0, 6
SIGNAL_TRACES, SIGNAL_LOGS = 0, 2
AGG_AVG, AGG_COUNT, AGG_PERCENTILE = 3, 4, 8
OP_EQUAL, EVAL_AND = 0, 1
PREPROC_MULTIPLIER, PREPROC_JSONPATH = 1, 12
HANDLER_DISCARD, HANDLER_VALUE = 1, 2


class ZabbixAPI:
    def __init__(self, url):
        self.url, self.token, self.id = url, None, 0

    def call(self, method, params=None, **kwargs):
        self.id += 1
        params = kwargs if params is None else params
        headers = {"Content-Type": "application/json-rpc"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": self.id}).encode()
        resp = json.load(urllib.request.urlopen(urllib.request.Request(self.url, body, headers), timeout=60))
        if "error" in resp:
            raise RuntimeError(f"{method}: {resp['error']}")
        return resp["result"]


def wait_api(api, seconds=300):
    deadline = time.time() + seconds
    while True:
        try:
            return api.call("apiinfo.version", [])
        except (urllib.error.URLError, OSError, ValueError) as e:
            if time.time() > deadline:
                raise SystemExit(f"API não respondeu em {seconds}s: {e}")
            time.sleep(3)


def cond(column, value, attribute_key=""):
    return {"column": column, "attribute_key": attribute_key, "operator": OP_EQUAL, "value": value}


def master_items(hostid, service):
    server_spans = {"evaltype": EVAL_AND, "conditions": [cond("ServiceName", service), cond("SpanKind", "Server")]}
    error_spans = {"evaltype": EVAL_AND, "conditions": [
        cond("ServiceName", service), cond("SpanKind", "Server"), cond("StatusCode", "Error")]}
    error_logs = {"evaltype": EVAL_AND, "conditions": [cond("ServiceName", service), cond("SeverityText", "ERROR")]}
    base = {"hostid": hostid, "type": ITEM_TYPE_TELEMETRY_QUERY, "value_type": VALUE_JSON, "delay": "1m",
            "granularity": "1m", "lookback_limit": "10m", "time_shift": "0", "history": "7d"}
    return [
        base | {"name": "APM: latência de requisições (raw)", "key_": "apm.latency.raw", "query": {
            "signal_type": SIGNAL_TRACES, "columns": [], "filter": server_spans,
            "aggregated_columns": [
                {"function": AGG_COUNT, "column": "", "parameters": [], "alias": "requests"},
                {"function": AGG_AVG, "column": "Duration", "parameters": [], "alias": "avg_ns"},
                {"function": AGG_PERCENTILE, "column": "Duration", "parameters": [95], "alias": "p95_ns"}]}},
        base | {"name": "APM: requisições com erro (raw)", "key_": "apm.errors.raw", "query": {
            "signal_type": SIGNAL_TRACES, "columns": [], "filter": error_spans,
            "aggregated_columns": [{"function": AGG_COUNT, "column": "", "parameters": [], "alias": "errors"}]}},
        base | {"name": "APM: logs ERROR (raw)", "key_": "apm.logs.error.raw", "query": {
            "signal_type": SIGNAL_LOGS, "columns": [], "filter": error_logs,
            "aggregated_columns": [{"function": AGG_COUNT, "column": "", "parameters": [], "alias": "count"}]}},
    ]


def dependent_items(hostid, masters):
    """JSONPath $[0].<alias> (formato da rc3). Sem dados: contadores gravam 0, p95 descarta o valor."""
    def dep(master_key, name, key, path, steps_extra=(), handler=HANDLER_VALUE, units=""):
        jsonpath = {"type": PREPROC_JSONPATH, "params": path, "error_handler": handler,
                    "error_handler_params": "0" if handler == HANDLER_VALUE else ""}
        return {"hostid": hostid, "name": name, "key_": key, "type": ITEM_TYPE_DEPENDENT,
                "master_itemid": masters[master_key], "value_type": VALUE_FLOAT, "units": units,
                "history": "7d", "preprocessing": [jsonpath, *steps_extra]}
    multiplier = {"type": PREPROC_MULTIPLIER, "params": "0.000000001", "error_handler": 0, "error_handler_params": ""}
    return [
        dep("apm.latency.raw", "APM: requisições por minuto", "apm.requests", "$[0].requests"),
        dep("apm.latency.raw", "APM: latência p95", "apm.latency.p95", "$[0].p95_ns", (multiplier,), HANDLER_DISCARD, "s"),
        dep("apm.errors.raw", "APM: requisições com erro por minuto", "apm.errors", "$[0].errors"),
        dep("apm.logs.error.raw", "APM: logs ERROR por minuto", "apm.logs.error", "$[0].count"),
    ]


def triggers(h):
    return [
        {"description": f"{h}: sem requisições há 5 minutos", "priority": 2,
         "expression": f"max(/{h}/apm.requests,5m)=0",
         "recovery_mode": 1, "recovery_expression": f"min(/{h}/apm.requests,2m)>0",
         "comments": "Nenhuma requisição chegou ao APM nos últimos 5 minutos. Fecha após 2 minutos com tráfego."},
        {"description": f"{h}: latência p95 alta", "priority": 3,
         "expression": f"avg(/{h}/apm.latency.p95,3m)>{{$APM.P95.MAX}} and last(/{h}/apm.requests)>0",
         "recovery_mode": 1,
         "recovery_expression": f"max(/{h}/apm.latency.p95,5m)<={{$APM.P95.MAX}} or last(/{h}/apm.requests)=0",
         "comments": "Média do p95 nos últimos 3 minutos acima de {$APM.P95.MAX} s. Fecha quando o p95 fica "
                     "5 minutos seguidos abaixo do limite, ou quando o tráfego para."},
        {"description": f"{h}: requisições com erro", "priority": 4,
         "expression": f"avg(/{h}/apm.errors,3m)>={{$APM.ERRORS.MAX}}",
         "recovery_mode": 1, "recovery_expression": f"max(/{h}/apm.errors,5m)<{{$APM.ERRORS.MAX}}",
         "comments": "Média de {$APM.ERRORS.MAX} ou mais requisições com erro por minuto nos últimos 3 minutos."},
        {"description": f"{h}: muitos logs ERROR", "priority": 4,
         "expression": f"avg(/{h}/apm.logs.error,3m)>={{$APM.LOGS.MAX}}",
         "recovery_mode": 1, "recovery_expression": f"max(/{h}/apm.logs.error,5m)<{{$APM.LOGS.MAX}}",
         "comments": "Média de {$APM.LOGS.MAX} ou mais logs ERROR por minuto nos últimos 3 minutos."},
    ]


def ensure_host(api, groupid, service, p95):
    macros = [{"macro": "{$APM.P95.MAX}", "value": str(p95)},
              {"macro": "{$APM.ERRORS.MAX}", "value": str(ERRORS_MAX)},
              {"macro": "{$APM.LOGS.MAX}", "value": str(LOGS_MAX)}]
    hosts = api.call("host.get", filter={"host": [service]}, output=["hostid"])
    if hosts:
        hostid = hosts[0]["hostid"]
        api.call("host.update", hostid=hostid, macros=macros)
    else:
        hostid = api.call("host.create", host=service, groups=[{"groupid": groupid}], macros=macros)["hostids"][0]

    existing = {i["key_"]: i["itemid"] for i in api.call("item.get", hostids=hostid, output=["itemid", "key_"])}
    for item in master_items(hostid, service):
        if item["key_"] not in existing:
            existing[item["key_"]] = api.call("item.create", item)["itemids"][0]
    for item in dependent_items(hostid, existing):
        if item["key_"] not in existing:
            existing[item["key_"]] = api.call("item.create", item)["itemids"][0]

    new = triggers(service)
    old = {t["description"]: t["triggerid"] for t in api.call(
        "trigger.get", hostids=hostid, output=["description"], filter={"description": [t["description"] for t in new]})}
    for t in new:
        if t["description"] in old:
            api.call("trigger.update", t | {"triggerid": old[t["description"]]})
        else:
            api.call("trigger.create", t)
    return hostid


def ensure_viewer(api, groupid):
    """Usuário comum com leitura só no grupo apps; a role recebe acesso ao módulo depois que ele existir."""
    roles = api.call("role.get", filter={"name": ["APM dashboard viewer"]}, output=["roleid"])
    if roles:
        roleid = roles[0]["roleid"]
    else:
        roleid = api.call("role.create", name="APM dashboard viewer", type=1)["roleids"][0]
    ugs = api.call("usergroup.get", filter={"name": ["apps-viewers"]}, output=["usrgrpid"])
    if ugs:
        usrgrpid = ugs[0]["usrgrpid"]
    else:
        usrgrpid = api.call("usergroup.create", name="apps-viewers",
                            hostgroup_rights=[{"id": groupid, "permission": 2}])["usrgrpids"][0]
    if not api.call("user.get", filter={"username": ["viewer"]}, output=["userid"]):
        api.call("user.create", username="viewer", passwd="Sd-lab-2026!", roleid=roleid,
                 usrgrps=[{"usrgrpid": usrgrpid}])
    return roleid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8080/zabbix/api_jsonrpc.php")
    parser.add_argument("--user", default="Admin")
    parser.add_argument("--password", default="zabbix")
    args = parser.parse_args()
    api = ZabbixAPI(args.url)
    print("Zabbix API", wait_api(api))
    api.token = api.call("user.login", username=args.user, password=args.password)

    api.call("settings.update", apm_global_db={"status": 1, "authentication_type": 0, **CLICKHOUSE})
    print("fonte de APM: ClickHouse configurado")

    proxies = api.call("proxy.get", filter={"name": [PROXY]}, output=["proxyid"])
    proxyid = proxies[0]["proxyid"] if proxies else api.call("proxy.create", name=PROXY, operating_mode=0)["proxyids"][0]
    api.call("proxy.update", proxyid=proxyid, apm={"data_collection_status": 1})
    print(f"proxy {PROXY}: coleta de APM habilitada (proxyid {proxyid})")

    groups = api.call("hostgroup.get", filter={"name": [GROUP]}, output=["groupid"])
    groupid = groups[0]["groupid"] if groups else api.call("hostgroup.create", name=GROUP)["groupids"][0]
    for service, p95 in P95_MAX.items():
        hostid = ensure_host(api, groupid, service, p95)
        print(f"  {service}: hostid {hostid}")

    ensure_viewer(api, groupid)
    print("usuário viewer / Sd-lab-2026! (role 'APM dashboard viewer', só leitura em 'apps')")
    api.call("user.logout", [])


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(str(e))
