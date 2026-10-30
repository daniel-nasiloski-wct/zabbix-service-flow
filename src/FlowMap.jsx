import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { dur, num, pct } from './format.js'
import Tooltip from './Tooltip.jsx'

const NODE_W = 284
const NODE_H = 82
const PAD = 48
const DURATION = 750
const MAX_SCALE = 1.15

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a, b, t) => a + (b - a) * t

export function Icon({ kind }) {
  if (kind === 'db') {
    return (
      <svg viewBox="0 0 24 24" className="icon">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    )
  }
  if (kind === 'external') {
    return (
      <svg viewBox="0 0 24 24" className="icon">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="icon">
      <path d="M12 2l8.7 5v10L12 22l-8.7-5V7z" />
      <path d="M12 7l4.3 2.5v5L12 17l-4.3-2.5v-5z" />
    </svg>
  )
}

// Resumo do card: valores dos itens do Zabbix quando existem, senão as contas feitas sobre os spans.
export function summary(n) {
  const it = n.items || {}
  if (n.kind === 'service' && it['apm.requests']) {
    // Sem requisições o item de p95 não é atualizado; o último valor seria enganoso.
    const rpm = Number(it['apm.requests'].lastvalue)
    const p95 = rpm > 0 && it['apm.latency.p95'] ? dur(it['apm.latency.p95'].lastvalue) : '—'
    const err = it['apm.errors'] ? Number(it['apm.errors'].lastvalue) : 0
    return [`${num(rpm, 0)} req/min`, `p95 ${p95}`, `${num(err, 0)} errors/min`]
  }
  if (n.kind === 'service') return [`${num(n.stats.rpm, 0)} req/min`, `p95 ${dur(n.stats.p95)}`, `${pct(n.stats.errPct)} errors`]
  return [`${num(n.stats.rpm, 0)} calls/min`, `p95 ${dur(n.stats.p95)}`, `${pct(n.stats.errPct)} errors`]
}

const KIND_LABEL = { service: 'Service', db: 'Database', external: 'External service' }

// Interpola posições, opacidade e tamanho da cena entre dois layouts.
function frame(scene, t) {
  const e = ease(t)
  const nodes = new Map()
  for (const [id, s] of scene.nodes) {
    nodes.set(id, {
      node: s.node, leaving: s.leaving,
      x: lerp(s.from.x, s.to.x, e), y: lerp(s.from.y, s.to.y, e), o: lerp(s.from.o, s.to.o, e),
    })
  }
  const edges = new Map()
  for (const [key, s] of scene.edges) edges.set(key, { edge: s.edge, leaving: s.leaving, o: lerp(s.from, s.to, e) })
  const b = scene.bounds
  return { nodes, edges, w: lerp(b.from.w, b.to.w, e), h: lerp(b.from.h, b.to.h, e) }
}

function bounds(view) {
  return {
    w: Math.max(NODE_W, ...view.nodes.map((n) => n.x + NODE_W)),
    h: Math.max(NODE_H, ...view.nodes.map((n) => n.y + NODE_H)),
  }
}

// A cada novo layout, anima do quadro atual até o novo: nós que ficam deslizam, os novos entram
// pela esquerda com fade e os que saem desaparecem no lugar.
function useAnimatedScene(view) {
  const sceneRef = useRef(null)
  const progressRef = useRef(1)
  const [, setTick] = useState(0)

  useEffect(() => {
    const cur = sceneRef.current ? frame(sceneRef.current, progressRef.current) : null
    const target = new Map(view.nodes.map((n) => [n.id, n]))
    const nodes = new Map()
    for (const n of view.nodes) {
      const was = cur?.nodes.get(n.id)
      const from = was && !was.leaving ? { x: was.x, y: was.y, o: was.o }
        : was ? { x: was.x, y: was.y, o: was.o } : { x: n.x - 60, y: n.y, o: 0 }
      nodes.set(n.id, { node: n, from, to: { x: n.x, y: n.y, o: 1 } })
    }
    if (cur) {
      for (const [id, was] of cur.nodes) {
        if (!target.has(id) && was.o > 0.02) {
          nodes.set(id, { node: was.node, leaving: true, from: { x: was.x, y: was.y, o: was.o }, to: { x: was.x + 40, y: was.y, o: 0 } })
        }
      }
    }
    const edges = new Map()
    const keys = new Set(view.edges.map((e) => e.key))
    for (const e of view.edges) edges.set(e.key, { edge: e, from: cur?.edges.get(e.key)?.o ?? 0, to: 1 })
    if (cur) {
      for (const [key, was] of cur.edges) {
        if (!keys.has(key) && was.o > 0.02 && nodes.has(was.edge.from) && nodes.has(was.edge.to)) {
          edges.set(key, { edge: was.edge, leaving: true, from: was.o, to: 0 })
        }
      }
    }
    const to = bounds(view)
    sceneRef.current = { nodes, edges, bounds: { from: cur ? { w: cur.w, h: cur.h } : to, to } }

    progressRef.current = 0
    const start = performance.now()
    let raf
    const step = (now) => {
      progressRef.current = Math.min(1, (now - start) / DURATION)
      if (progressRef.current === 1) {
        // Fim da animação: tira da cena o que já sumiu.
        const sc = sceneRef.current
        for (const [id, s] of sc.nodes) if (s.leaving) sc.nodes.delete(id)
        for (const [key, s] of sc.edges) if (s.leaving) sc.edges.delete(key)
      }
      setTick((n) => n + 1)
      if (progressRef.current < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [view])

  return sceneRef.current ? frame(sceneRef.current, progressRef.current) : null
}

function useSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [ref])
  return size
}

function edgePath(a, b) {
  const x1 = a.x + NODE_W
  const y1 = a.y + NODE_H / 2
  const x2 = b.x - 4
  const y2 = b.y + NODE_H / 2
  const dx = Math.max(40, (x2 - x1) / 2)
  return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export default function FlowMap({ view, selected, frontend, onSelect }) {
  const wrapRef = useRef(null)
  const size = useSize(wrapRef)
  const scene = useAnimatedScene(view)
  const [hover, setHover] = useState(null)
  const [tip, setTip] = useState(null)
  const hideTimer = useRef(null)

  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const edgeByKey = new Map(view.edges.map((e) => [e.key, e]))

  const show = (target, anchor) => {
    clearTimeout(hideTimer.current)
    setHover(target)
    setTip({ ...target, anchor, visible: true })
  }
  const hide = () => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setHover(null)
      setTip((t) => t && { ...t, visible: false })
      hideTimer.current = setTimeout(() => setTip(null), 200)
    }, 160)
  }
  const keep = () => {
    clearTimeout(hideTimer.current)
    setTip((t) => t && { ...t, visible: true })
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const related = (e) => !hover || (hover.type === 'edge' ? hover.id === e.key : e.from === hover.id || e.to === hover.id)
  const nodeRelated = (id) => !hover || (hover.type === 'node' ? hover.id === id
    || view.edges.some((e) => (e.from === hover.id && e.to === id) || (e.to === hover.id && e.from === id))
    : edgeByKey.get(hover.id)?.from === id || edgeByKey.get(hover.id)?.to === id)

  // Encaixa a cena na área disponível, sem ampliar demais um fluxo pequeno.
  const scale = scene && size.w ? Math.min((size.w - PAD * 2) / scene.w, (size.h - PAD * 2) / scene.h, MAX_SCALE) : 1
  const ox = scene ? (size.w - scene.w * scale) / 2 : 0
  const oy = scene ? (size.h - scene.h * scale) / 2 : 0

  const tipOk = tip && (tip.type === 'node' ? byId.has(tip.id) : edgeByKey.has(tip.id))

  return (
    <div className="flowmap" ref={wrapRef}>
      {scene && size.w > 0 && (
        <div className="scene" style={{ transform: `translate(${ox}px, ${oy}px) scale(${scale})` }}>
          <svg className="edges" width={scene.w} height={scene.h}>
            <defs>
              {['ok', 'warn', 'crit'].map((s) => (
                <marker key={s} id={`arrow-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9"
                  markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" className={`arrow ${s}`} />
                </marker>
              ))}
            </defs>
            {[...scene.edges.values()].map(({ edge: e, o, leaving }) => {
              const a = scene.nodes.get(e.from)
              const b = scene.nodes.get(e.to)
              if (!a || !b) return null
              const d = edgePath(a, b)
              const w = 1.6 + Math.min(4.5, Math.log2(1 + e.stats.rpm))
              const active = hover?.type === 'edge' && hover.id === e.key
              const lit = hover && !leaving && related(e)
              return (
                <g key={e.key} style={{ opacity: o }}
                  className={`edge ${e.state} ${!leaving && related(e) ? '' : 'dim'} ${active ? 'active' : ''} ${lit ? 'lit' : ''}`}>
                  <path d={d} className="edge-base" strokeWidth={w} markerEnd={`url(#arrow-${e.state})`} />
                  <path d={d} className="edge-flow" strokeWidth={Math.max(1.2, w - 1.4)} />
                  {!leaving && (
                    <path d={d} className="edge-hit"
                      onMouseEnter={(ev) => show({ type: 'edge', id: e.key }, { x: ev.clientX + 14, y: ev.clientY + 14, alt: ev.clientX - 14 })}
                      onMouseLeave={hide} />
                  )}
                </g>
              )
            })}
          </svg>

          {[...scene.nodes.values()].map(({ node: n, x, y, o, leaving }) => {
            const [l1, l2, l3] = summary(n)
            const dim = leaving || !nodeRelated(n.id)
            return (
              <div key={n.id} className="node-pos" style={{ transform: `translate(${x}px, ${y}px)`, opacity: o,
                width: NODE_W, height: NODE_H, pointerEvents: leaving ? 'none' : 'auto' }}>
                <div
                  className={`node ${n.kind} ${n.state} ${n.id === selected ? 'selected' : ''} ${dim ? 'dim' : ''} ${hover?.id === n.id ? 'hovered' : ''}`}
                  onMouseEnter={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    show({ type: 'node', id: n.id }, { x: r.right + 14, y: r.top - 6, alt: r.left - 14 })
                  }}
                  onMouseLeave={hide}
                  onClick={() => n.kind === 'service' && onSelect(n.id === selected ? '' : n.id)}
                >
                  <div className="node-icon"><Icon kind={n.kind} /></div>
                  <div className="node-body">
                    <div className="node-title">
                      <span className="node-name">{n.label}</span>
                      {n.problems?.length > 0 && <span className={`badge ${n.state}`}>{n.problems.length}</span>}
                    </div>
                    <div className="node-kind">{n.kindLabel || KIND_LABEL[n.kind]}</div>
                    <div className="node-metrics"><span>{l1}</span><span>{l2}</span><span>{l3}</span></div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tipOk && (
        <Tooltip tip={tip} byId={byId} edgeByKey={edgeByKey} frontend={frontend} onEnter={keep} onLeave={hide} />
      )}
    </div>
  )
}
