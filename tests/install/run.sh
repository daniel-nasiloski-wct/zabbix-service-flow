#!/bin/sh
# Roda o install.sh em containers de outras distros (só o pacote do frontend instalado) e confere a
# detecção do diretório, as permissões e o uninstall. Uso: tests/install/run.sh [rockylinux9 debian12 ...]
set -eu
cd "$(dirname "$0")/../.."
distros=${*:-rockylinux9 debian12}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/pkg/zabbix-service-flow-main"
cp -R zabbix_service_dashboard "$tmp/pkg/zabbix-service-flow-main/"
tar -czf "$tmp/sd.tgz" -C "$tmp/pkg" zabbix-service-flow-main

rc=0
for d in $distros; do
  echo "===== $d ====="
  docker build -q -t "sd-install-$d" -f "tests/install/Dockerfile.$d" tests/install >/dev/null
  docker run --rm -v "$PWD/install.sh:/tmp/install.sh:ro" -v "$tmp/sd.tgz:/tmp/sd.tgz:ro" "sd-install-$d" sh -c '
    set -e
    sh /tmp/install.sh status
    sh /tmp/install.sh --archive /tmp/sd.tgz --dry-run
    sh /tmp/install.sh --archive /tmp/sd.tgz >/dev/null
    sh /tmp/install.sh status
    dir=$(sh /tmp/install.sh status | sed -n "s/.* in //p")
    stat -c "%U:%G %a %n" "$dir" "$dir/manifest.json" "$dir/assets/js/service-dashboard.js"
    n=$(find "$dir" -type f | wc -l); echo "arquivos: $n"; [ "$n" -ge 12 ]
    sh /tmp/install.sh --archive /tmp/sd.tgz >/dev/null && echo "reinstalação (upgrade) OK"
    sh /tmp/install.sh uninstall | head -n 2
    [ ! -d "$dir" ] && echo "uninstall OK"
  ' || { echo "FALHOU: $d"; rc=1; }
done
exit $rc
