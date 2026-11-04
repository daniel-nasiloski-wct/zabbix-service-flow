// Gera uma fixture determinística de spans no formato da apmspan.get (campos que o grafo usa), com
// cadeias entre serviços, chamadas a banco/externo, erros e spans órfãos, para o teste de paridade
// entre src/graph.js e o port PHP. Uso: node tests/make-fixture.mjs > tests/fixtures/spans-synthetic.json
let seed = 20261103
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('')

const MINUTES = 15
const till = 1762200000
const from = till - MINUTES * 60

const APPS = [
  { entry: 'checkout-demo', calls: ['catalog-api', 'auth-service', 'payment-gateway'], db: 'mysql', ext: null },
  { entry: 'bank-portal', calls: ['account-service', 'fraud-engine'], db: 'postgresql', ext: 'ldap.lab' },
  { entry: '1234', calls: ['routing-engine'], db: null, ext: 'maps.example' }, // nome numérico de propósito
]
const LEAF_DB = { 'catalog-api': 'mysql', 'payment-gateway': null, 'auth-service': null, 'account-service': 'postgresql', 'fraud-engine': 'redis', 'routing-engine': 'mysql' }
const LEAF_EXT = { 'payment-gateway': 'api.pagamentos.com', 'auth-service': 'ldap.lab' }

const spans = []
function span(service, name, kind, parent, traceid, ts, durNs, error, attrs = {}) {
  const s = {
    traceid, spanid: hex(16), parent_spanid: parent ? parent.spanid : '', span_name: name, span_kind: kind,
    service_name: service, span_attributes: attrs, duration: String(durNs), status_code: error ? 'Error' : (rnd() < 0.3 ? 'Ok' : 'Unset'),
    timestamp: String(ts) + '000000000'.slice(0, 9),
  }
  spans.push(s)
  return s
}
const ns = (ms) => Math.round(ms * 1e6)

for (let t = from; t < till; t += 2) {
  for (const app of APPS) {
    const traceid = hex(32)
    const error = rnd() < 0.05
    const root = span(app.entry, 'GET /' + app.entry, 'Server', null, traceid, t, ns(80 + rnd() * 200), error)
    if (app.db) span(app.entry, 'SELECT orders', 'Client', root, traceid, t, ns(2 + rnd() * 20), false, { 'db.system': app.db })
    if (app.ext) span(app.entry, 'bind', 'Client', root, traceid, t, ns(5 + rnd() * 50), rnd() < 0.1, { 'server.address': app.ext })
    for (const callee of app.calls) {
      if (rnd() < 0.2) continue
      const client = span(app.entry, 'POST ' + callee, 'Client', root, traceid, t, ns(20 + rnd() * 120), rnd() < 0.04)
      const server = span(callee, 'POST /' + callee.split('-')[0], 'Server', client, traceid, t, ns(10 + rnd() * 100), rnd() < 0.06)
      if (LEAF_DB[callee]) span(callee, 'query', 'Client', server, traceid, t, ns(1 + rnd() * 15), rnd() < 0.02, { 'db.system': LEAF_DB[callee] })
      if (LEAF_EXT[callee]) span(callee, 'call', 'Client', server, traceid, t, ns(30 + rnd() * 300), rnd() < 0.15, { 'server.address': LEAF_EXT[callee], 'http.method': 'POST' })
      if (rnd() < 0.3) span(callee, 'work', 'Internal', server, traceid, t, ns(1 + rnd() * 5), false)
    }
  }
  // Span órfão (pai fora da janela) e span Client sem atributos úteis (não vira nó).
  if (t % 60 === 0) {
    span('shipping-service', 'POST /ship', 'Server', { spanid: hex(16) }, hex(32), t, ns(50), false)
    span('shipping-service', 'notify', 'Client', null, hex(32), t, ns(12), false, { 'messaging.system': 'smtp' })
  }
}

// Topologia salva para o mergeKnown: um serviço sem tráfego, uma ligação antiga e uma remoção.
const known = {
  nodes: [
    { id: 'legacy-api', kind: 'service', label: 'legacy-api', lastSeen: from - 3600 },
    { id: 'db:oracle@legacy-api', kind: 'db', label: 'oracle', lastSeen: from - 3600 },
    { id: 'checkout-demo', kind: 'service', label: 'checkout-demo', lastSeen: from - 10 },
  ],
  edges: [
    { key: 'legacy-api→db:oracle@legacy-api', from: 'legacy-api', to: 'db:oracle@legacy-api', lastSeen: from - 3600 },
    { key: 'checkout-demo→legacy-api', from: 'checkout-demo', to: 'legacy-api', lastSeen: from - 3600 },
  ],
  hidden: { 'fraud-engine': till + 100, 'bank-portal': from - 100 },
}
const apmHosts = ['checkout-demo', 'warehouse-api', 'fraud-engine']

process.stdout.write(JSON.stringify({ minutes: MINUTES, spans, known, apmHosts }))
