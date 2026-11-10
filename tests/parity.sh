#!/bin/sh
# Paridade entre src/graph.js (Node) e o port PHP (CGraph.php) em mergeKnown e seenTopology, sobre o
# grafo que o buildGraph do JS monta da fixture. O PHP roda em container (php:8.3-cli), o Node localmente.
# Uso: tests/parity.sh [fixture.json]  (padrão: tests/fixtures/spans-synthetic.json)
set -eu
cd "$(dirname "$0")/.."
fixture=${1:-tests/fixtures/spans-synthetic.json}
mkdir -p tests/fixtures tests/.out
[ -f "$fixture" ] || node tests/make-fixture.mjs > "$fixture"

node tests/graph-parity.mjs "$fixture" | python3 -m json.tool --indent 1 > tests/.out/js.json
docker run --rm -v "$PWD:/w" -w /w php:8.3-cli php tests/graph-parity.php "$fixture" tests/.out/js.json | python3 -m json.tool --indent 1 > tests/.out/php.json

if diff -q tests/.out/js.json tests/.out/php.json >/dev/null; then
  echo "paridade OK ($(wc -c < tests/.out/js.json | tr -d ' ') bytes iguais, fixture $fixture)"
else
  echo "DIFERENÇAS (js < > php):"
  diff tests/.out/js.json tests/.out/php.json | head -60
  exit 1
fi
