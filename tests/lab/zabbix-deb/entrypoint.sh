#!/bin/sh
# Sobe PostgreSQL (schema do Zabbix), zabbix_server e o frontend (Apache + mod-php) num container só
# (Ubuntu ou Debian; os caminhos dos pacotes .deb do Zabbix são os mesmos nos dois).
set -eu

DB_HOST=${DB_HOST:-db}
CH_URL=${CH_URL:-http://clickhouse:8123}
export PGPASSWORD=zabbix

echo "[lab] aguardando o PostgreSQL em $DB_HOST"
until psql -h "$DB_HOST" -U zabbix -d zabbix -c 'select 1' >/dev/null 2>&1; do sleep 2; done

if [ "$(psql -h "$DB_HOST" -U zabbix -d zabbix -tAc "select count(*) from information_schema.tables where table_name='config'")" = "0" ]; then
  echo "[lab] importando o schema do Zabbix"
  schema=$(find /usr/share -name server.sql.gz -path '*postgresql*' | head -n 1)
  [ -n "$schema" ] || { echo "[lab] server.sql.gz não encontrado"; exit 1; }
  zcat "$schema" | psql -q -h "$DB_HOST" -U zabbix -d zabbix >/dev/null
fi

# Troca um parâmetro do arquivo de configuração: apaga as linhas (comentadas ou não) e grava no fim.
set_opt() {
  file=$1; key=$2; val=$3
  sed -i -E "/^#?[[:space:]]*${key}=/d" "$file"
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

conf=/etc/zabbix/zabbix_server.conf
set_opt "$conf" DBHost "$DB_HOST"
set_opt "$conf" DBName zabbix
set_opt "$conf" DBUser zabbix
set_opt "$conf" DBPassword zabbix
set_opt "$conf" LogType console
set_opt "$conf" TelemetryProvider "clickhouse;url=${CH_URL},db=zabbix,username=zabbix,password=zabbix"
# ~160 hosts com 3 itens Telemetry query a cada minuto (scale_hosts.py): um poller só não dá conta.
set_opt "$conf" StartTelemetryQueryPollers 5

# Fuso horário do PHP do frontend (o apache.conf do 8.0 não traz mais a linha date.timezone).
for d in /etc/php/*/apache2/conf.d; do
  printf 'date.timezone = America/Sao_Paulo\n' > "$d/99-lab-timezone.ini"
done

mkdir -p /run/zabbix /var/log/zabbix /var/run/apache2
chown zabbix:zabbix /run/zabbix /var/log/zabbix
echo "[lab] subindo zabbix_server"
zabbix_server -c "$conf" -f &
echo "[lab] frontend em http://localhost:8080/zabbix/"
exec apache2ctl -D FOREGROUND
