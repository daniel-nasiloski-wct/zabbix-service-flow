// Roda buildGraph/seenTopology/mergeKnown de src/graph.js sobre uma fixture e imprime o resultado
// normalizado (chaves ordenadas, floats arredondados, nulls removidos) para comparar com o PHP.
import { readFileSync } from 'node:fs'
import { buildGraph, mergeKnown, seenTopology } from '../src/graph.js'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const graph = buildGraph(fixture.spans, fixture.minutes)
const out = {
  graph,
  seen: seenTopology(graph),
  merged: mergeKnown(graph, fixture.known || { nodes: [], edges: [], hidden: {} }, fixture.apmHosts || [], fixture.minutes),
}

function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== null && v[k] !== undefined).map((k) => [k, normalize(v[k])]))
  }
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toFixed(6))
  return v
}
process.stdout.write(JSON.stringify(normalize(out), null, 1))
