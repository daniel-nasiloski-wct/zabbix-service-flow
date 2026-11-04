"""Chamada avulsa à API do Zabbix do lab (login Admin/zabbix, chama, faz logout).

Uso: python3 api.py <método> ['<params em JSON>'] [--url ...] [--user ...] [--password ...]
Ex.: python3 api.py module.get '{"output":"extend"}'
"""

import argparse
import json
import sys

from seed import ZabbixAPI


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("method")
    parser.add_argument("params", nargs="?", default="{}")
    parser.add_argument("--url", default="http://localhost:8080/zabbix/api_jsonrpc.php")
    parser.add_argument("--user", default="Admin")
    parser.add_argument("--password", default="zabbix")
    args = parser.parse_args()
    api = ZabbixAPI(args.url)
    api.token = api.call("user.login", username=args.user, password=args.password)
    try:
        print(json.dumps(api.call(args.method, json.loads(args.params)), indent=1, ensure_ascii=False))
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
    finally:
        api.call("user.logout", [])


if __name__ == "__main__":
    main()
