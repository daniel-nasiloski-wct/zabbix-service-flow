"""Cria (ou remove) no Zabbix do lab os hosts das aplicações de escala do scale_catalog.py.

Cada serviço vira um host no grupo "apps" com os mesmos 3 itens Telemetry query, 4 dependentes, macros e
4 triggers do seed.py; a macro {$APM.P95.MAX} sai da latência esperada do serviço no catálogo. Os itens e
triggers de cada host são criados em lote (uma chamada por tipo), porque são ~140 hosts. Idempotente.

Uso: python3 scale_hosts.py [--apps 40] [--remove] [--url …] [--user Admin] [--password zabbix]
"""

import argparse
import sys

from scale_catalog import catalog, p95_limit
from seed import ERRORS_MAX, GROUP, ZabbixAPI, dependent_items, master_items, triggers, wait_api


def ensure_host(api, groupid, service, p95):
    # As plataformas compartilhadas recebem ~10 vezes mais requisições: limite de erros proporcional.
    errors_max = ERRORS_MAX * 3 if service.startswith("platform-") else ERRORS_MAX
    macros = [{"macro": "{$APM.P95.MAX}", "value": str(p95)},
              {"macro": "{$APM.ERRORS.MAX}", "value": str(errors_max)},
              {"macro": "{$APM.LOGS.MAX}", "value": str(errors_max)}]
    hosts = api.call("host.get", filter={"host": [service]}, output=["hostid"])
    if hosts:
        hostid = hosts[0]["hostid"]
        api.call("host.update", hostid=hostid, macros=macros)
    else:
        hostid = api.call("host.create", host=service, groups=[{"groupid": groupid}], macros=macros)["hostids"][0]

    existing = {i["key_"]: i["itemid"] for i in api.call("item.get", hostids=hostid, output=["itemid", "key_"])}
    masters = [i for i in master_items(hostid, service) if i["key_"] not in existing]
    if masters:
        for item, itemid in zip(masters, api.call("item.create", masters)["itemids"]):
            existing[item["key_"]] = itemid
    dependents = [i for i in dependent_items(hostid, existing) if i["key_"] not in existing]
    if dependents:
        api.call("item.create", dependents)

    new = triggers(service)
    old = {t["description"]: t["triggerid"] for t in api.call(
        "trigger.get", hostids=hostid, output=["description"], filter={"description": [t["description"] for t in new]})}
    to_update = [t | {"triggerid": old[t["description"]]} for t in new if t["description"] in old]
    to_create = [t for t in new if t["description"] not in old]
    if to_update:
        api.call("trigger.update", to_update)
    if to_create:
        api.call("trigger.create", to_create)
    return hostid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8080/zabbix/api_jsonrpc.php")
    parser.add_argument("--user", default="Admin")
    parser.add_argument("--password", default="zabbix")
    parser.add_argument("--apps", type=int, default=40)
    parser.add_argument("--remove", action="store_true", help="apaga os hosts do catálogo em vez de criar")
    args = parser.parse_args()

    cat = catalog(args.apps)
    names = sorted(cat["services"])
    api = ZabbixAPI(args.url)
    print("Zabbix API", wait_api(api))
    api.token = api.call("user.login", username=args.user, password=args.password)
    try:
        if args.remove:
            hosts = api.call("host.get", filter={"host": names}, output=["hostid", "host"])
            if hosts:
                api.call("host.delete", [h["hostid"] for h in hosts])
            print(f"{len(hosts)} hosts removidos")
            return
        groups = api.call("hostgroup.get", filter={"name": [GROUP]}, output=["groupid"])
        groupid = groups[0]["groupid"] if groups else api.call("hostgroup.create", name=GROUP)["groupids"][0]
        for n, name in enumerate(names, 1):
            hostid = ensure_host(api, groupid, name, p95_limit(cat["services"], name))
            print(f"  {n:3}/{len(names)} {name}: hostid {hostid}", flush=True)
        print(f"{len(names)} hosts prontos no grupo '{GROUP}' ({len(cat['apps'])} aplicações)")
    finally:
        api.call("user.logout", [])


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(str(e))
