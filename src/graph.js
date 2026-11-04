// Monta o fluxo de serviços a partir dos spans: quem chama quem, com estatísticas por ligação,
// e cruza com os hosts do Zabbix (host = service.name) para saber quem está em incidente.
import { t as i18n } from './i18n.js'

const MAX_SAMPLES = 200
// Passo da grade da visão geral (cards de 284×82 com folga).
export const OVERVIEW_COL_W = 360
export const OVERVIEW_ROW_H = 140

function p95(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

function stats(acc, minutes) {
  return {
    count: acc.durations.length,
    rpm: acc.durations.length / minutes,
    errors: acc.errors,
    errPct: acc.durations.length ? (100 * acc.errors) / acc.durations.length : 0,
    p95: p95(acc.durations),
    avg: acc.durations.length ? acc.durations.reduce((a, b) => a + b, 0) / acc.durations.length : 0,
  }
}

function newAcc() {
  return { durations: [], errors: 0, samples: [], ops: new Map(), last: 0 }
}

const spanTime = (span) => Number(span.timestamp) / 1e9

function add(acc, span, op) {
  const seconds = Number(span.duration) / 1e9
  const error = span.status_code === 'Error'
  acc.durations.push(seconds)
  acc.errors += error
  if (op) acc.ops.set(op, (acc.ops.get(op) || 0) + 1)
  acc.last = Math.max(acc.last, spanTime(span))
  acc.samples.push({ traceid: span.traceid, seconds, error, ts: Number(span.timestamp) / 1e6, op })
  if (acc.samples.length > MAX_SAMPLES) acc.samples.shift()
}

// Traces para o tooltip: primeiro os com erro, depois os mais lentos.
function topTraces(samples, n = 5) {
  return [...samples].sort((a, b) => b.error - a.error || b.seconds - a.seconds).slice(0, n)
}

export function buildGraph(spans, minutes) {
  const byId = new Map(spans.map((s) => [s.spanid, s]))
  const nodes = new Map()
  const edges = new Map()
  const remoteParents = new Set()
  const lastSeen = new Map()

  const node = (id, kind, label) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, acc: newAcc(), endpoints: new Map() })
    return nodes.get(id)
  }
  const edge = (from, to) => {
    const key = `${from}→${to}`
    if (!edges.has(key)) edges.set(key, { key, from, to, acc: newAcc() })
    return edges.get(key)
  }

  // Ligações entre serviços: span filho em outro serviço; a estatística vem do span CLIENT do chamador.
  for (const s of spans) {
    node(s.service_name, 'service', s.service_name)
    lastSeen.set(s.service_name, Math.max(lastSeen.get(s.service_name) || 0, spanTime(s)))
    const parent = byId.get(s.parent_spanid)
    if (parent && parent.service_name !== s.service_name) {
      remoteParents.add(parent.spanid)
      add(edge(parent.service_name, s.service_name).acc, parent, `${parent.span_name} → ${s.span_name}`)
    }
  }

  for (const s of spans) {
    const svc = nodes.get(s.service_name)
    if (s.span_kind === 'Server') {
      add(svc.acc, s, s.span_name)
      if (!svc.endpoints.has(s.span_name)) svc.endpoints.set(s.span_name, newAcc())
      add(svc.endpoints.get(s.span_name), s)
    } else if (s.span_kind === 'Client' && !remoteParents.has(s.spanid)) {
      // Chamada para algo sem instrumentação: banco (db.system) ou serviço externo (server.address).
      const attrs = s.span_attributes || {}
      let target = null
      // Um nó por chamador: o mysql do checkout e o do shipping são bancos diferentes.
      const db = attrs['db.system']
      const ext = attrs['server.address']
      if (db) target = node(`db:${db}@${s.service_name}`, 'db', db)
      else if (ext) target = node(`ext:${ext}@${s.service_name}`, 'external', ext)
      if (target) {
        add(edge(s.service_name, target.id).acc, s, s.span_name)
        add(target.acc, s, `${s.service_name}: ${s.span_name}`)
      }
    }
  }

  const finalNodes = [...nodes.values()].map((n) => ({
    id: n.id, kind: n.kind, label: n.label,
    lastSeen: lastSeen.get(n.id) || n.acc.last,
    stats: stats(n.acc, minutes),
    endpoints: [...n.endpoints.entries()].map(([name, acc]) => ({ name, ...stats(acc, minutes) }))
      .sort((a, b) => b.count - a.count),
    traces: topTraces(n.acc.samples),
  }))
  const finalEdges = [...edges.values()].map((e) => ({
    key: e.key, from: e.from, to: e.to,
    lastSeen: e.acc.last,
    stats: stats(e.acc, minutes),
    ops: [...e.acc.ops.entries()].map(([name, count]) => ({ name, rpm: count / minutes }))
      .sort((a, b) => b.rpm - a.rpm),
    traces: topTraces(e.acc.samples),
  }))
  return { nodes: finalNodes, edges: finalEdges }
}

// Junta o que veio nos spans da janela com a topologia salva (known) e os hosts com itens apm.*:
// o que não teve tráfego na janela continua no mapa, marcado como idle. O que o usuário removeu
// (known.hidden, id → horário da remoção) só volta se tiver um span mais novo que a remoção.
export function mergeKnown(graph, known, apmHosts, minutes) {
  const hiddenAt = known.hidden || {}
  const shown = (id, last) => !(id in hiddenAt) || (last || 0) > hiddenAt[id]
  const idleStats = stats(newAcc(), minutes)

  const nodes = new Map()
  for (const n of graph.nodes) if (shown(n.id, n.lastSeen)) nodes.set(n.id, { ...n, idle: false })
  for (const n of known.nodes) {
    if (!nodes.has(n.id) && shown(n.id, n.lastSeen)) {
      nodes.set(n.id, { ...n, stats: idleStats, endpoints: [], traces: [], idle: true })
    }
  }
  for (const host of apmHosts) {
    if (!nodes.has(host) && !(host in hiddenAt)) {
      nodes.set(host, { id: host, kind: 'service', label: host, lastSeen: null, stats: idleStats, endpoints: [], traces: [], idle: true })
    }
  }

  const edges = new Map()
  for (const e of graph.edges) if (nodes.has(e.from) && nodes.has(e.to)) edges.set(e.key, { ...e, idle: false })
  for (const e of known.edges) {
    if (!edges.has(e.key) && nodes.has(e.from) && nodes.has(e.to)) {
      edges.set(e.key, { ...e, stats: idleStats, ops: [], traces: [], idle: true })
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

// O que vai para a topologia salva: só o que teve span na janela.
export function seenTopology(graph) {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, lastSeen: n.lastSeen })),
    edges: graph.edges.map((e) => ({ key: e.key, from: e.from, to: e.to, lastSeen: e.lastSeen })),
  }
}

const RANK = { ok: 0, unknown: 0, warn: 1, crit: 2 }

export function severityState(priority) {
  const p = Number(priority)
  if (p >= 4) return 'crit'
  if (p >= 2) return 'warn'
  return 'ok'
}

// Estado de cada nó/ligação a partir das triggers em problema no Zabbix.
//  - serviço: pior severidade das triggers do host com o mesmo nome;
//  - ligação para serviço: herda o estado do serviço chamado;
//  - ligação para banco/externo: herda o estado do chamador quando ela é a suspeita
//    (10% ou mais de erros, ou p95 a partir de 500 ms).
export function applyHealth(graph, data) {
  const hostByName = new Map(data.hosts.map((h) => [h.host, h]))
  const problemsByHost = new Map()
  for (const t of data.triggers) {
    for (const h of t.hosts) {
      if (!problemsByHost.has(h.hostid)) problemsByHost.set(h.hostid, [])
      problemsByHost.get(h.hostid).push(t)
    }
  }
  const itemsByHost = new Map()
  const historyByItem = new Map()
  for (const v of data.history) {
    if (!historyByItem.has(v.itemid)) historyByItem.set(v.itemid, [])
    historyByItem.get(v.itemid).push(Number(v.value))
  }
  for (const i of data.items) {
    if (!itemsByHost.has(i.hostid)) itemsByHost.set(i.hostid, {})
    itemsByHost.get(i.hostid)[i.key_] = { ...i, history: historyByItem.get(i.itemid) || [] }
  }

  const nodes = new Map()
  for (const n of graph.nodes) {
    const host = n.kind === 'service' ? hostByName.get(n.id) : null
    const problems = host ? (problemsByHost.get(host.hostid) || []).sort((a, b) => b.priority - a.priority) : []
    const state = n.kind !== 'service' ? 'ok' : !host ? 'unknown'
      : problems.reduce((s, t) => (RANK[severityState(t.priority)] > RANK[s] ? severityState(t.priority) : s), 'ok')
    nodes.set(n.id, { ...n, host, problems, state, items: host ? itemsByHost.get(host.hostid) || {} : {} })
  }

  const edges = graph.edges.map((e) => {
    const from = nodes.get(e.from)
    const to = nodes.get(e.to)
    let state = 'ok'
    if (to.kind === 'service') state = to.state === 'unknown' ? 'ok' : to.state
    else if (RANK[from.state] > 0 && (e.stats.errPct >= 10 || e.stats.p95 >= 0.5)) state = from.state
    return { ...e, state }
  })
  for (const e of edges) {
    const to = nodes.get(e.to)
    if (to.kind !== 'service' && RANK[e.state] > RANK[to.state]) to.state = e.state
  }
  return { nodes, edges }
}

// Colunas da esquerda para a direita. Com um serviço selecionado: quem chama à esquerda,
// o serviço no centro e as dependências à direita. Sem seleção: o mapa inteiro.
export function layout(graph, selected) {
  const out = new Map()
  const inc = new Map()
  for (const e of graph.edges) {
    if (!out.has(e.from)) out.set(e.from, [])
    if (!inc.has(e.to)) inc.set(e.to, [])
    out.get(e.from).push(e.to)
    inc.get(e.to).push(e.from)
  }

  const layer = new Map()
  const walk = (start, next, sign) => {
    const queue = [[start, 0]]
    while (queue.length) {
      const [id, d] = queue.shift()
      if (Math.abs(d) > 8) continue
      if (layer.has(id) && Math.abs(layer.get(id)) >= Math.abs(d)) continue
      layer.set(id, d)
      for (const n of next.get(id) || []) queue.push([n, d + sign])
    }
  }

  if (selected && graph.nodes.has(selected)) {
    walk(selected, out, 1)
    const down = new Map(layer)
    layer.clear()
    walk(selected, inc, -1)
    for (const [id, d] of down) if (!layer.has(id) || id === selected) layer.set(id, d)
  } else {
    const roots = [...graph.nodes.keys()].filter((id) => !(inc.get(id) || []).length)
    for (const r of roots) walk(r, out, 1)
    for (const id of graph.nodes.keys()) if (!layer.has(id)) layer.set(id, 0)
  }

  const ids = new Set(layer.keys())
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && layer.get(e.to) > layer.get(e.from))

  // Ordem dentro de cada coluna pela média da posição de quem chama (menos cruzamentos).
  const columns = new Map()
  for (const [id, d] of layer) {
    if (!columns.has(d)) columns.set(d, [])
    columns.get(d).push(id)
  }
  const order = [...columns.keys()].sort((a, b) => a - b)
  const pos = new Map()
  for (const d of order) {
    const col = columns.get(d)
    const score = (id) => {
      const parents = edges.filter((e) => e.to === id && pos.has(e.from)).map((e) => pos.get(e.from))
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 0
    }
    const kindRank = (id) => (graph.nodes.get(id).kind === 'service' ? 0 : 1)
    col.sort((a, b) => score(a) - score(b) || kindRank(a) - kindRank(b) || a.localeCompare(b))
    col.forEach((id, i) => pos.set(id, i))
  }

  const COL_W = 360
  const ROW_H = 118
  const tallest = Math.max(...order.map((d) => columns.get(d).length))
  const placed = new Map()
  order.forEach((d, ci) => {
    const col = columns.get(d)
    const offset = ((tallest - col.length) * ROW_H) / 2
    col.forEach((id, i) => placed.set(id, { ...graph.nodes.get(id), x: ci * COL_W, y: offset + i * ROW_H }))
  })
  return { nodes: [...placed.values()], edges, width: order.length * COL_W, height: tallest * ROW_H }
}

// Aplicações (clientes): cada serviço que ninguém chama é a entrada de uma aplicação, e a aplicação
// é tudo o que ele alcança. O estado da aplicação é o pior estado entre os membros.
export function tenants(graph) {
  const calledBy = new Set()
  const out = new Map()
  for (const e of graph.edges) {
    if (graph.nodes.get(e.from).kind === 'service' && graph.nodes.get(e.to).kind === 'service') calledBy.add(e.to)
    if (!out.has(e.from)) out.set(e.from, [])
    out.get(e.from).push(e.to)
  }
  const roots = [...graph.nodes.values()].filter((n) => n.kind === 'service' && !calledBy.has(n.id))
  return roots.map((root) => {
    const members = new Set([root.id])
    const queue = [root.id]
    while (queue.length) {
      for (const next of out.get(queue.shift()) || []) {
        if (!members.has(next)) {
          members.add(next)
          queue.push(next)
        }
      }
    }
    const nodes = [...members].map((id) => graph.nodes.get(id))
    const state = nodes.reduce((s, n) => (RANK[n.state] > RANK[s] ? n.state : s), 'ok')
    return {
      id: root.id, root, state, members,
      services: nodes.filter((n) => n.kind === 'service').map((n) => n.id).sort((a, b) =>
        (a === root.id ? -1 : b === root.id ? 1 : a.localeCompare(b))),
      dependencies: nodes.filter((n) => n.kind !== 'service').length,
      problems: nodes.flatMap((n) => (n.problems || []).map((p) => ({ ...p, service: n.id })))
        .sort((a, b) => b.priority - a.priority),
      graph: { nodes: new Map(nodes.map((n) => [n.id, n])), edges: graph.edges.filter((e) => members.has(e.from) && members.has(e.to)) },
    }
  }).sort((a, b) => RANK[b.state] - RANK[a.state] || a.id.localeCompare(b.id))
}

// Visão geral: só os cards das aplicações (serviço de entrada), em grade. Cada card leva o pior estado
// e todos os problemas da aplicação, e é o mesmo nó do fluxo, para a troca de tela animar.
// A grade tende ao quadrado; maxCols (quantas colunas cabem na largura sem encolher os cards abaixo
// do mínimo) limita, e o que sobrar desce e rola.
// `grid` (passo e colunas) é o que o arrastar-e-soltar do modo de edição usa para encaixar o card na
// grade; `animMs` encurta a animação de reacomodação dos outros cards durante o arrasto.
export function overviewLayout(apps, maxCols = Infinity, animMs = undefined) {
  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(apps.length)), maxCols))
  const nodes = apps.map((t, i) => ({
    ...t.root,
    state: t.state,
    problems: t.problems,
    kindLabel: i18n('Application · %1$s services', t.services.length),
    x: (i % cols) * OVERVIEW_COL_W,
    y: Math.floor(i / cols) * OVERVIEW_ROW_H,
  }))
  return { nodes, edges: [], grid: { cols, colW: OVERVIEW_COL_W, rowH: OVERVIEW_ROW_H }, animMs }
}

// Ordem salva (Save do modo de edição) primeiro; o que não está nela segue a ordem padrão (estado, nome).
export function sortApps(apps, order) {
  if (!order || !order.length) return apps
  const rank = new Map(order.map((id, i) => [id, i]))
  return apps.map((a, i) => [a, rank.has(a.id) ? rank.get(a.id) : order.length + i])
    .sort((a, b) => a[1] - b[1]).map(([a]) => a)
}
