#!/bin/sh
# php -l em todos os arquivos do módulo (PHP 8.1, o mínimo que o módulo promete) e sh -n nos scripts.
set -eu
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD/zabbix_service_dashboard:/m:ro" php:8.1-cli sh -c 'rc=0; for f in $(find /m -name "*.php"); do out=$(php -l "$f" 2>&1) || { echo "$out"; rc=1; }; done; [ $rc -eq 0 ] && echo "php -l OK ($(find /m -name "*.php" | wc -l | tr -d " ") arquivos)"; exit $rc'
for f in install.sh tests/*.sh tests/lab/*/entrypoint.sh; do [ -f "$f" ] && sh -n "$f"; done
echo "sh -n OK"
