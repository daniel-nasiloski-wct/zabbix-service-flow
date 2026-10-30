// Cliente mínimo da API JSON-RPC do Zabbix. A API já responde CORS, então o navegador chama direto.

export class Zabbix {
  constructor(url, token = null) {
    this.url = url
    this.token = token
    this.id = 0
  }

  async call(method, params = {}) {
    const headers = { 'Content-Type': 'application/json-rpc' }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const resp = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++this.id }),
    })
    const data = await resp.json()
    if (data.error) throw new Error(`${method}: ${data.error.data || data.error.message}`)
    return data.result
  }

  static async login(url, username, password) {
    const api = new Zabbix(url)
    api.token = await api.call('user.login', { username, password })
    return api
  }

  // Endereço do frontend do Zabbix, para os links de trace e problemas.
  get frontend() {
    return this.url.replace(/api_jsonrpc\.php$/, '')
  }
}

export const ITEM_KEYS = ['apm.requests', 'apm.latency.p95', 'apm.errors', 'apm.logs.error']

const SPAN_FIELDS = ['traceid', 'spanid', 'parent_spanid', 'span_name', 'span_kind', 'service_name',
  'span_attributes', 'duration', 'status_code', 'timestamp']

// Spans da janela + hosts, itens, histórico e triggers em problema dos hosts com o mesmo nome do service.name.
export async function loadData(api, minutes) {
  const till = Math.floor(Date.now() / 1000)
  const from = till - minutes * 60
  const spans = await api.call('apmspan.get', { time_from: from, time_till: till, limit: 50000, output: SPAN_FIELDS })
  const names = [...new Set(spans.map((s) => s.service_name))]

  const hosts = names.length
    ? await api.call('host.get', { filter: { host: names }, output: ['hostid', 'host', 'name'] })
    : []
  const hostids = hosts.map((h) => h.hostid)
  const [items, triggers] = hostids.length
    ? await Promise.all([
        api.call('item.get', {
          hostids, filter: { key_: ITEM_KEYS },
          output: ['itemid', 'hostid', 'key_', 'name', 'lastvalue', 'lastclock', 'units'],
        }),
        api.call('trigger.get', {
          hostids, filter: { value: 1 }, monitored: true, skipDependent: true, expandDescription: true,
          output: ['triggerid', 'description', 'priority', 'lastchange'], selectHosts: ['hostid'],
        }),
      ])
    : [[], []]
  const history = items.length
    ? await api.call('history.get', {
        itemids: items.map((i) => i.itemid), history: 0, time_from: till - 30 * 60,
        sortfield: 'clock', sortorder: 'ASC', output: ['itemid', 'clock', 'value'],
      })
    : []

  return { spans, hosts, items, triggers, history, from, till }
}
