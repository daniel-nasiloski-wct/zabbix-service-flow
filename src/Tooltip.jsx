import React, { useLayoutEffect, useRef, useState } from 'react'
import { SEVERITY, STATE_LABEL, clock, dur, num, pct, since } from './format.js'
import { severityState } from './graph.js'

function Sparkline({ values }) {
  if (values.length < 2) return <svg className="spark" />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24 - 2}`).join(' ')
  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none">
      <polyline points={pts} />
    </svg>
  )
}

const traceUrl = (frontend, id) =>
  `${frontend}zabbix.php?action=apm.trace.list&filter_set=1&filter_traceid=${id}&from=now-1h&to=now`

function Traces({ traces, frontend }) {
  if (!traces.length) return null
  return (
    <section>
      <h4>Traces (errors and slowest)</h4>
      <table className="traces">
        <tbody>
          {traces.map((t) => (
            <tr key={`${t.traceid}-${t.ts}`}>
              <td><i className={`dot ${t.error ? 'crit' : 'ok'}`} /></td>
              <td className="mono">
                <a href={traceUrl(frontend, t.traceid)} target="_blank" rel="noreferrer">{t.traceid.slice(0, 12)}…</a>
              </td>
              <td className="op">{t.op}</td>
              <td className="num">{dur(t.seconds)}</td>
              <td className="num muted">{clock(t.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Stats({ s, rpmLabel = 'Calls/min' }) {
  return (
    <div className="stats">
      <div><span>{rpmLabel}</span><b>{num(s.rpm, 1)}</b></div>
      <div><span>p95</span><b>{dur(s.p95)}</b></div>
      <div><span>Average</span><b>{dur(s.avg)}</b></div>
      <div><span>Errors</span><b>{pct(s.errPct)}</b></div>
    </div>
  )
}

const ZBX_ITEMS = [
  ['apm.requests', 'Requests/min', (v) => num(v, 0)],
  ['apm.latency.p95', 'p95 latency', dur],
  ['apm.errors', 'Errors/min', (v) => num(v, 0)],
  ['apm.logs.error', 'Logs ERROR/min', (v) => num(v, 0)],
]

function NodeTip({ n, frontend }) {
  return (
    <>
      <header>
        <h3>{n.label}</h3>
        <span className={`pill ${n.state}`}>{STATE_LABEL[n.state]}</span>
      </header>

      {n.problems?.length > 0 && (
        <section>
          <h4>Zabbix problems</h4>
          <ul className="problems">
            {n.problems.map((p) => (
              <li key={p.triggerid} className={severityState(p.priority)}>
                <span className="sev">{SEVERITY[p.priority]}</span>
                <span>{p.description}</span>
                <span className="muted">{since(p.lastchange)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {n.host && (
        <section>
          <h4>Zabbix items (host {n.host.host}, last 30 min)</h4>
          <div className="items">
            {ZBX_ITEMS.map(([key, label, fmt]) => {
              const it = n.items[key]
              return (
                <div key={key} className="item">
                  <span>{label}</span>
                  <b>{it ? fmt(it.lastvalue) : '—'}</b>
                  <Sparkline values={it ? it.history : []} />
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section>
        <h4>{n.kind === 'service' ? 'Inbound spans (traces)' : 'Incoming calls (traces)'}</h4>
        <Stats s={n.stats} rpmLabel={n.kind === 'service' ? 'Requests/min' : 'Calls/min'} />
      </section>

      {n.endpoints?.length > 0 && (
        <section>
          <h4>Endpoints</h4>
          <table className="endpoints">
            <thead><tr><th>Operation</th><th>req/min</th><th>p95</th><th>errors</th></tr></thead>
            <tbody>
              {n.endpoints.map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td><td className="num">{num(e.rpm, 1)}</td>
                  <td className="num">{dur(e.p95)}</td><td className="num">{pct(e.errPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <Traces traces={n.traces} frontend={frontend} />
      {n.host && (
        <footer>
          <a href={`${frontend}zabbix.php?action=problem.view&filter_set=1&hostids[]=${n.host.hostid}`}
            target="_blank" rel="noreferrer">Open host problems in Zabbix ↗</a>
        </footer>
      )}
    </>
  )
}

function EdgeTip({ e, byId, frontend }) {
  return (
    <>
      <header>
        <h3>{byId.get(e.from).label} → {byId.get(e.to).label}</h3>
        <span className={`pill ${e.state}`}>{STATE_LABEL[e.state]}</span>
      </header>
      <section><Stats s={e.stats} /></section>
      <section>
        <h4>Operations</h4>
        <ul className="ops">
          {e.ops.map((o) => <li key={o.name}><span>{o.name}</span><span className="muted">{num(o.rpm, 1)}/min</span></li>)}
        </ul>
      </section>
      <Traces traces={e.traces} frontend={frontend} />
    </>
  )
}

export default function Tooltip({ tip, byId, edgeByKey, frontend, onEnter, onLeave }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  // Ao lado do elemento; troca de lado e sobe quando não cabe na tela.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    let left = tip.anchor.x
    if (left + width > window.innerWidth - 12) left = Math.max(12, tip.anchor.alt - width)
    const top = Math.max(12, Math.min(tip.anchor.y, window.innerHeight - height - 12))
    setPos({ left, top })
  }, [tip.id, tip.anchor.x, tip.anchor.y])

  const node = tip.type === 'node' ? byId.get(tip.id) : null
  return (
    <div ref={ref} className={`tooltip ${tip.visible && pos ? 'visible' : ''} ${pos ? 'placed' : ''}`}
      style={pos || { left: tip.anchor.x, top: tip.anchor.y }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div key={tip.id} className="tooltip-content">
        {node ? <NodeTip n={node} frontend={frontend} /> : <EdgeTip e={edgeByKey.get(tip.id)} byId={byId} frontend={frontend} />}
      </div>
    </div>
  )
}
