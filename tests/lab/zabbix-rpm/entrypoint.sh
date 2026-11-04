#!/bin/sh
# Sobe PostgreSQL (schema do Zabbix), zabbix_server e o frontend (php-fpm + httpd) num container só.
set -eu

DB_HOST=${DB_HOST:-db}
CH_URL=${CH_URL:-http://clickhouse:8123}
export PGPASSWORD=zabbix

echo "[lab] aguardando o PostgreSQL em $DB_HOST"
until psql -h "$DB_HOST" -U zabbix -d zabbix -c 'select 1' >/dev/null 2>&1; do sleep 2; done

if [ "$(psql -h "$DB_HOST" -U zabbix -d zabbix -tAc "select count(*) from information_schema.tables where table_name='config'")" = "0" ]; then
  echo "[lab] importando o schema do Zabbix"
  zcat /usr/share/zabbix/sql-scripts/postgresql/server.sql.gz | psql -q -h "$DB_HOST" -U zabbix -d zabbix >/dev/null
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

# php-fpm do frontend: fuso horário (o pacote deixa comentado).
sed -i -E 's|^;?[[:space:]]*php_value\[date.timezone\].*|php_value[date.timezone] = America/Sao_Paulo|' /etc/php-fpm.d/zabbix.conf

mkdir -p /run/php-fpm /run/httpd
php-fpm --daemonize
echo "[lab] subindo zabbix_server"
zabbix_server -c "$conf" -f &
echo "[lab] frontend em http://localhost:8080/zabbix/"
exec httpd -DFOREGROUND
