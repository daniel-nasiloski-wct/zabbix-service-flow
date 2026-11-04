import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { dur, num, pct, since } from './format.js'
import { t } from './i18n.js'
import Tooltip from './Tooltip.jsx'

export const NODE_W = 284
export const NODE_H = 82
export const PAD = 48
const DURATION = 750
const MAX_SCALE = 1.15
// Os cards nunca encolhem (pedido do usuário: em 0,85 já ficaram ilegíveis); se não cabe, o mapa rola.
export const MIN_SCALE = 1
// Tempo que o card leva para assentar na célula depois de solto.
const SETTLE_MS = 350

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

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
  if (n.idle) return [t('No traffic in the window'), n.lastSeen ? t('last span %1$s', since(n.lastSeen)) : t('no spans seen yet'), '']
  if (n.kind === 'service' && it['apm.requests']) {
    // Sem requisições o item de p95 não é atualizado; o último valor seria enganoso.
    const rpm = Number(it['apm.requests'].lastvalue)
    const p95 = rpm > 0 && it['apm.latency.p95'] ? dur(it['apm.latency.p95'].lastvalue) : '—'
    const err = it['apm.errors'] ? Number(it['apm.errors'].lastvalue) : 0
    return [t('%1$s req/min', num(rpm, 0)), t('p95 %1$s', p95), t('%1$s errors/min', num(err, 0))]
  }
  if (n.kind === 'service') return [t('%1$s req/min', num(n.stats.rpm, 0)), t('p95 %1$s', dur(n.stats.p95)), t('%1$s errors', pct(n.stats.errPct))]
  return [t('%1$s calls/min', num(n.stats.rpm, 0)), t('p95 %1$s', dur(n.stats.p95)), t('%1$s errors', pct(n.stats.errPct))]
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
// pela esquerda com fade e os que saem desaparecem no lugar. view.animMs encurta a animação (usado
// na reacomodação dos cards durante o arrasto).
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

    const duration = view.animMs || DURATION
    progressRef.current = 0
    const start = performance.now()
    let raf
    const step = (now) => {
      progressRef.current = Math.min(1, (now - start) / duration)
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

const TIP_DELAY_MS = 2000

// editing: modo de edição (como o do dashboard do Zabbix). Sem destaque nem tooltip; cada card de
// aplicação/serviço ganha um X no canto (onRemove(node)); clicar no card não navega; na visão geral
// (view.grid) os cards são arrastados para outra célula da grade (onReorder(id, índice)).
export default function FlowMap({ view, selected, frontend, onSelect, editing = false, onRemove, onReorder }) {
  const wrapRef = useRef(null)
  const sceneRef = useRef(null)
  const size = useSize(wrapRef)
  const scene = useAnimatedScene(view)
  const [hover, setHover] = useState(null)
  const [tip, setTip] = useState(null)
  const hideTimer = useRef(null)
  const showTimer = useRef(null)

  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const edgeByKey = new Map(view.edges.map((e) => [e.key, e]))

  // O destaque é imediato; o tooltip só abre se o mouse ficar TIP_DELAY_MS parado no mesmo alvo.
  const show = (target, anchor) => {
    if (editing) return
    clearTimeout(hideTimer.current)
    clearTimeout(showTimer.current)
    setHover(target)
    setTip((t) => t && { ...t, visible: false })
    showTimer.current = setTimeout(() => setTip({ ...target, anchor, visible: true }), TIP_DELAY_MS)
  }
  const hide = () => {
    clearTimeout(hideTimer.current)
    clearTimeout(showTimer.current)
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
  useEffect(() => () => { clearTimeout(hideTimer.current); clearTimeout(showTimer.current) }, [])
  // Entrar no modo de edição apaga qualquer destaque/tooltip que estivesse aberto.
  useEffect(() => {
    if (editing) {
      clearTimeout(hideTimer.current)
      clearTimeout(showTimer.current)
      setHover(null)
      setTip(null)
    }
  }, [editing])

  const related = (e) => !hover || (hover.type === 'edge' ? hover.id === e.key : e.from === hover.id || e.to === hover.id)
  const nodeRelated = (id) => !hover || (hover.type === 'node' ? hover.id === id
    || view.edges.some((e) => (e.from === hover.id && e.to === id) || (e.to === hover.id && e.from === id))
    : edgeByKey.get(hover.id)?.from === id || edgeByKey.get(hover.id)?.to === id)

  // Encaixa a cena na área disponível, sem ampliar demais um fluxo pequeno nem encolher abaixo do
  // legível: quando não cabe em MIN_SCALE, a área de rolagem cresce e o mapa rola.
  const fit = scene && size.w ? Math.min((size.w - PAD * 2) / scene.w, (size.h - PAD * 2) / scene.h, MAX_SCALE) : 1
  const scale = Math.max(fit, MIN_SCALE)
  const areaW = scene ? Math.max(size.w, scene.w * scale + PAD * 2) : 0
  const areaH = scene ? Math.max(size.h, scene.h * scale + PAD * 2) : 0
  const ox = scene ? (areaW - scene.w * scale) / 2 : 0
  const oy = scene ? (areaH - scene.h * scale) / 2 : 0

  // Arrastar e soltar na grade da visão geral. O card arrastado segue o ponteiro (sem animação, por
  // cima dos outros); quando cruza para outra célula, a ordem muda e os demais deslizam para abrir
  // espaço; ao soltar, ele assenta na célula com uma transição curta.
  const grid = view.grid
  const canDrag = editing && grid && typeof onReorder === 'function'
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const settleTimer = useRef(null)
  const stopListening = useRef(null)
  useEffect(() => () => { clearTimeout(settleTimer.current); stopListening.current?.() }, [])
  const toScene = (ev) => {
    const r = sceneRef.current.getBoundingClientRect()
    return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale }
  }
  const slotOf = (x, y) => {
    const count = view.nodes.length
    const rows = Math.max(1, Math.ceil(count / grid.cols))
    const col = clamp(Math.round(x / grid.colW), 0, grid.cols - 1)
    const row = clamp(Math.round(y / grid.rowH), 0, rows - 1)
    return Math.min(row * grid.cols + col, count - 1)
  }
  // O movimento e o soltar são ouvidos na janela, não no card: a captura de ponteiro se perde no
  // Safari quando o elemento é mexido durante o arrasto, e aí o card nem chega a trocar de célula.
  const moveDrag = (ev) => {
    const d = dragRef.current
    if (!d) return
    const p = toScene(ev)
    d.x = p.x - d.offX
    d.y = p.y - d.offY
    const index = slotOf(d.x, d.y)
    if (index !== d.index) {
      d.index = index
      onReorder(d.id, index)
    }
    setDrag({ ...d })
  }
  const endDrag = () => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    stopListening.current?.()
    setDrag({ ...d, settling: true })
    settleTimer.current = setTimeout(() => setDrag(null), SETTLE_MS)
  }
  const startDrag = (ev, n, x, y) => {
    if (!canDrag || n.kind !== 'service' || ev.button !== 0 || ev.target.closest('.node-remove')) return
    ev.preventDefault()
    const p = toScene(ev)
    dragRef.current = { id: n.id, offX: p.x - x, offY: p.y - y, x, y, index: view.nodes.findIndex((m) => m.id === n.id) }
    clearTimeout(settleTimer.current)
    stopListening.current?.()
    window.addEventListener('pointermove', moveDrag)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    stopListening.current = () => {
      window.removeEventListener('pointermove', moveDrag)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      stopListening.current = null
    }
    setDrag({ ...dragRef.current })
  }

  const tipOk = tip && (tip.type === 'node' ? byId.has(tip.id) : edgeByKey.has(tip.id))

  return (
    <div className={`flowmap ${editing ? 'editing' : ''}`} ref={wrapRef}>
      {scene && size.w > 0 && (
        <div className="scroll-area" style={{ width: areaW, height: areaH }}>
        <div className="scene" ref={sceneRef} style={{ transform: `translate(${ox}px, ${oy}px) scale(${scale})` }}>
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
                  className={`edge ${e.state} ${e.idle ? 'idle' : ''} ${!leaving && related(e) ? '' : 'dim'} ${active ? 'active' : ''} ${lit ? 'lit' : ''}`}>
                  <path d={d} className="edge-base" strokeWidth={w} markerEnd={`url(#arrow-${e.state})`} />
                  <path d={d} className="edge-flow" strokeWidth={Math.max(1.2, w - 1.4)} />
                  {!leaving && !editing && (
                    <path d={d} className="edge-hit"
                      onMouseEnter={(ev) => show({ type: 'edge', id: e.key }, { x: ev.clientX + 14, y: ev.clientY + 14, alt: ev.clientX - 14 })}
                      onMouseLeave={hide} />
                  )}
                </g>
              )
            })}
          </svg>

          {/* Ordem do DOM estável (por id), e não a da cena: reordenar os cards no DOM durante o
              arrasto faz o Safari perder a captura do ponteiro e interromper o arrasto. */}
          {[...scene.nodes.values()].sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)).map(({ node: n, x, y, o, leaving }) => {
            const [l1, l2, l3] = summary(n)
            const dim = leaving || !nodeRelated(n.id)
            const dragging = drag && drag.id === n.id
            const px = dragging && !drag.settling ? drag.x : x
            const py = dragging && !drag.settling ? drag.y : y
            const removable = editing && !leaving && n.kind === 'service'
            return (
              <div key={n.id}
                className={`node-pos ${dragging ? (drag.settling ? 'settling' : 'dragging') : ''} ${canDrag && n.kind === 'service' ? 'draggable' : ''}`}
                style={{ transform: `translate(${px}px, ${py}px)`, opacity: o, width: NODE_W, height: NODE_H,
                  pointerEvents: leaving ? 'none' : 'auto', zIndex: dragging ? 10 : undefined }}
                onPointerDown={(ev) => startDrag(ev, n, x, y)}>
                <div
                  className={`node ${n.kind} ${n.state} ${n.idle ? 'idle' : ''} ${n.id === selected ? 'selected' : ''} ${dim ? 'dim' : ''} ${hover?.id === n.id ? 'hovered' : ''}`}
                  onMouseEnter={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    show({ type: 'node', id: n.id }, { x: r.right + 14, y: r.top - 6, alt: r.left - 14 })
                  }}
                  onMouseLeave={hide}
                  onClick={() => !editing && n.kind === 'service' && onSelect(n.id === selected ? '' : n.id)}
                >
                  <div className="node-icon"><Icon kind={n.kind} /></div>
                  <div className="node-body">
                    <div className="node-title">
                      <span className="node-name">{n.label}</span>
                      {n.problems?.length > 0 && <span className={`badge ${n.state}`}>{n.problems.length}</span>}
                    </div>
                    <div className="node-kind">{n.kindLabel || t(KIND_LABEL[n.kind])}</div>
                    <div className="node-metrics">{[l1, l2, l3].filter(Boolean).map((text) => <span key={text}>{text}</span>)}</div>
                  </div>
                </div>
                {removable && (
                  <button type="button" className="node-remove" title={t('Remove %1$s', n.label)} aria-label={t('Remove %1$s', n.label)}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => { ev.stopPropagation(); onRemove && onRemove(n) }}>
                    <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
                  </button>
                )}
              </div>
            )
          })}
        </div>
        </div>
      )}

      {tipOk && !editing && (
        <Tooltip tip={tip} byId={byId} edgeByKey={edgeByKey} frontend={frontend} onEnter={keep} onLeave={hide} />
      )}
    </div>
  )
}
