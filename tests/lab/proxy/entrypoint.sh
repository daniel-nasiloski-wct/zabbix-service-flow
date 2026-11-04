#!/bin/sh
# Proxy ativo "sdlab-proxy" com o coletor OTLP ligado. A porta 4317 só abre depois que o server manda a
# configuração com "Data collection enabled" (feito pelo seed.py via proxy.update).
set -eu

SERVER=${ZBX_SERVER:-zabbix}
CH_URL=${CH_URL:-http://clickhouse:8123}

set_opt() {
  file=$1; key=$2; val=$3
  sed -i -E "/^#?[[:space:]]*${key}=/d" "$file"
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

conf=/etc/zabbix/zabbix_proxy.conf
set_opt "$conf" Server "$SERVER"
set_opt "$conf" Hostname sdlab-proxy
set_opt "$conf" DBName /var/lib/zabbix/zabbix_proxy.db
set_opt "$conf" LogType console
set_opt "$conf" StartAPMCollector 1
set_opt "$conf" APMListenIP 0.0.0.0
set_opt "$conf" APMListenPort 4317
set_opt "$conf" TelemetryProvider "clickhouse;url=${CH_URL},db=zabbix,username=zabbix,password=zabbix"

mkdir -p /var/lib/zabbix
chown zabbix:zabbix /var/lib/zabbix
echo "[lab] subindo zabbix_proxy (APM) apontando para $SERVER e $CH_URL"
exec zabbix_proxy -c "$conf" -f
