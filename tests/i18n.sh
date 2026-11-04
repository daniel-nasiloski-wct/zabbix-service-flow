#!/bin/sh
# Traduções do módulo: compila cada .po em .mo (msgfmt, do gettext) e confere que todos os textos
# usados no PHP/JS estão no .pot. Uso: npm run i18n   (precisa de msgfmt/xgettext: brew install gettext)
set -eu
cd "$(dirname "$0")/.."
dir=zabbix_service_dashboard/locale
pot=$dir/zabbix_service_dashboard.pot

command -v msgfmt >/dev/null 2>&1 || { echo "msgfmt não encontrado (brew install gettext)"; exit 1; }

rc=0
for po in "$dir"/*/LC_MESSAGES/zabbix_service_dashboard.po; do
  lang=$(basename "$(dirname "$(dirname "$po")")")
  if ! out=$(msgfmt --check --statistics -o "${po%.po}.mo" "$po" 2>&1); then
    echo "$lang: ERRO: $out"; rc=1; continue
  fi
  case $out in
    *untranslated*|*fuzzy*) echo "$lang: INCOMPLETO: $out"; rc=1 ;;
    *) echo "$lang: $out" ;;
  esac
done

# Todo msgid do .pot precisa existir em todos os .po (e vice-versa).
msgids() { grep '^msgid "' "$1" | grep -v '^msgid ""$' | sort; }
msgids "$pot" > /tmp/sd-pot.$$
for po in "$dir"/*/LC_MESSAGES/zabbix_service_dashboard.po; do
  lang=$(basename "$(dirname "$(dirname "$po")")")
  if ! msgids "$po" | diff -q - /tmp/sd-pot.$$ >/dev/null; then
    echo "$lang: msgids diferentes do .pot:"; msgids "$po" | diff - /tmp/sd-pot.$$ | head -n 6; rc=1
  fi
done
rm -f /tmp/sd-pot.$$
[ $rc -eq 0 ] && echo "i18n OK ($(ls -d "$dir"/*/ | wc -l | tr -d ' ') idiomas)"
exit $rc
