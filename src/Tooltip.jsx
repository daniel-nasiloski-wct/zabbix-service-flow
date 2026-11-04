import React, { useLayoutEffect, useRef, useState } from 'react'
import { clock, dateTime, dur, num, pct, severityLabel, since, stateLabel } from './format.js'
import { severityState } from './graph.js'
import { t } from './i18n.js'

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
    <div className="tip-section">
      <h4>{t('Traces (errors and slowest)')}</h4>
      <table className="traces">
        <tbody>
          {traces.map((tr) => (
            <tr key={`${tr.traceid}-${tr.ts}`}>
              <td><i className={`dot ${tr.error ? 'crit' : 'ok'}`} /></td>
              <td className="mono">
                <a href={traceUrl(frontend, tr.traceid)} target="_blank" rel="noreferrer">{tr.traceid.slice(0, 12)}…</a>
              </td>
              <td className="op">{tr.op}</td>
              <td className="num">{dur(tr.seconds)}</td>
              <td className="num muted">{clock(tr.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stats({ s, rpmLabel }) {
  return (
    <div className="stats">
      <div><span>{rpmLabel || t('Calls/min')}</span><b>{num(s.rpm, 1)}</b></div>
      <div><span>{t('p95')}</span><b>{dur(s.p95)}</b></div>
      <div><span>{t('Average')}</span><b>{dur(s.avg)}</b></div>
      <div><span>{t('Errors')}</span><b>{pct(s.errPct)}</b></div>
    </div>
  )
}

const ZBX_ITEMS = [
  ['apm.requests', 'Requests/min', (v) => num(v, 0)],
  ['apm.latency.p95', 'p95 latency', dur],
  ['apm.errors', 'Errors/min', (v) => num(v, 0)],
  ['apm.logs.error', 'Logs ERROR/min', (v) => num(v, 0)],
]

// Sem spans na janela: o item vem da topologia salva ou de um host com itens apm.*.
function Idle({ lastSeen }) {
  return (
    <p className="idle-note">
      {t('No traffic in the selected time range.')}{' '}
      {lastSeen ? t('Last span %1$s (%2$s).', since(lastSeen), dateTime(lastSeen * 1000)) : t('No spans seen yet.')}
    </p>
  )
}

function NodeTip({ n, frontend }) {
  return (
    <>
      <div className="tip-head">
        <h3>{n.label}</h3>
        <span className={`pill ${n.state}`}>{stateLabel(n.state)}</span>
      </div>

      {n.problems?.length > 0 && (
        <div className="tip-section">
          <h4>{t('Zabbix problems')}</h4>
          <ul className="problems">
            {n.problems.map((p) => (
              <li key={p.triggerid} className={severityState(p.priority)}>
                <span className="sev">{severityLabel(p.priority)}</span>
                <span>{p.description}</span>
                <span className="muted">{since(p.lastchange)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {n.host && (
        <div className="tip-section">
          <h4>{t('Zabbix items (host %1$s, last 30 min)', n.host.host)}</h4>
          <div className="items">
            {ZBX_ITEMS.map(([key, label, fmt]) => {
              const it = n.items[key]
              return (
                <div key={key} className="item">
                  <span>{t(label)}</span>
                  <b>{it ? fmt(it.lastvalue) : '—'}</b>
                  <Sparkline values={it ? it.history : []} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {n.idle ? (
        <div className="tip-section"><Idle lastSeen={n.lastSeen} /></div>
      ) : (
        <div className="tip-section">
          <h4>{n.kind === 'service' ? t('Inbound spans (traces)') : t('Incoming calls (traces)')}</h4>
          <Stats s={n.stats} rpmLabel={n.kind === 'service' ? t('Requests/min') : t('Calls/min')} />
        </div>
      )}

      {n.endpoints?.length > 0 && (
        <div className="tip-section">
          <h4>{t('Endpoints')}</h4>
          <table className="endpoints">
            <thead><tr><th>{t('Operation')}</th><th>{t('req/min')}</th><th>{t('p95')}</th><th>{t('errors')}</th></tr></thead>
            <tbody>
              {n.endpoints.map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td><td className="num">{num(e.rpm, 1)}</td>
                  <td className="num">{dur(e.p95)}</td><td className="num">{pct(e.errPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Traces traces={n.traces} frontend={frontend} />
      {n.host && (
        <div className="tip-foot">
          <a href={`${frontend}zabbix.php?action=problem.view&filter_set=1&hostids[]=${n.host.hostid}`}
            target="_blank" rel="noreferrer">{t('Open host problems in Zabbix')} ↗</a>
        </div>
      )}
    </>
  )
}

function EdgeTip({ e, byId, frontend }) {
  return (
    <>
      <div className="tip-head">
        <h3>{byId.get(e.from).label} → {byId.get(e.to).label}</h3>
        <span className={`pill ${e.state}`}>{stateLabel(e.state)}</span>
      </div>
      {e.idle ? (
        <div className="tip-section"><Idle lastSeen={e.lastSeen} /></div>
      ) : (
        <>
          <div className="tip-section"><Stats s={e.stats} /></div>
          <div className="tip-section">
            <h4>{t('Operations')}</h4>
            <ul className="ops">
              {e.ops.map((o) => <li key={o.name}><span>{o.name}</span><span className="muted">{t('%1$s/min', num(o.rpm, 1))}</span></li>)}
            </ul>
          </div>
        </>
      )}
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
