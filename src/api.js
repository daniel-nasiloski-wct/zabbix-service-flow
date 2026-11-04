// Chamadas às ações do módulo (zabbix.php?action=servicedashboard.*), com a sessão do próprio Zabbix.
// O módulo devolve erros como {"error": "..."} e o Zabbix como {"error": {"title", "messages"}}.

function message(error) {
  if (typeof error === 'string') return error
  return [error?.title, ...(error?.messages || [])].filter(Boolean).join(' ')
}

export async function request(method, url, body) {
  const resp = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error ? message(data.error) : `HTTP ${resp.status}`)
  if (data.error) throw new Error(message(data.error))
  return data
}

export const get = (url) => request('GET', url)
export const post = (url, body) => request('POST', url, body)

// Filtro por atributos (do perfil do usuário, via bootstrap) no formato de campos do próprio Zabbix:
// filter_resource_attributes_evaltype=0&filter_resource_attributes[0][key]=…&[0][operator]=…&[0][value]=…
export function filterQuery(filter) {
  if (!filter) return ''
  const params = new URLSearchParams()
  for (const type of ['resource', 'span']) {
    const rows = filter[`${type}_attributes`] || []
    if (!rows.length) continue
    params.set(`filter_${type}_attributes_evaltype`, String(filter[`${type}_attributes_evaltype`] ?? 0))
    rows.forEach((row, i) => {
      params.set(`filter_${type}_attributes[${i}][key]`, row.key)
      params.set(`filter_${type}_attributes[${i}][operator]`, String(row.operator))
      params.set(`filter_${type}_attributes[${i}][value]`, row.value ?? '')
    })
  }
  const q = params.toString()
  return q ? `&${q}` : ''
}
