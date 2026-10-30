import React, { useEffect, useMemo, useState } from 'react'
import { Zabbix, loadData } from './zabbix.js'
import { applyHealth, buildGraph, layout, overviewLayout, tenants } from './graph.js'
import { clock } from './format.js'
import Login from './Login.jsx'
import FlowMap from './FlowMap.jsx'

const REFRESH_MS = 30000
const SESSION_KEY = 'zabbix-service-flow-session'

function restoreSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY))
    return s ? new Zabbix(s.url, s.token) : null
  } catch {
    return null
  }
}

export default function App() {
  const [api, setApi] = useState(restoreSession)
  const [selected, setSelected] = useState(() => decodeURIComponent(location.hash.slice(1)) || '')
  const [minutes, setMinutes] = useState(15)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState(null)

  const onLogin = (newApi) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ url: newApi.url, token: newApi.token }))
    } catch { /* sem storage: vale só para esta aba */ }
    setApi(newApi)
  }
  const logout = () => {
    try { sessionStorage.removeItem(SESSION_KEY) } catch { /* nada */ }
    setApi(null)
    setData(null)
  }

  useEffect(() => {
    location.hash = selected ? encodeURIComponent(selected) : ''
  }, [selected])

  useEffect(() => {
    if (!api) return undefined
    let alive = true
    const load = async () => {
      try {
        const d = await loadData(api, minutes)
        if (!alive) return
        setData(d)
        setError('')
        setUpdated(Date.now())
      } catch (e) {
        if (!alive) return
        if (/session|re-login|Not authori[sz]ed/i.test(e.message)) logout()
        setError(e.message)
      }
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, minutes])

  const health = useMemo(() => (data ? applyHealth(buildGraph(data.spans, minutes), data) : null), [data, minutes])
  const services = useMemo(
    () => (health ? [...health.nodes.values()].filter((n) => n.kind === 'service').map((n) => n.id).sort() : []),
    [health],
  )
  const apps = useMemo(() => (health ? tenants(health) : []), [health])
  const current = services.includes(selected) ? selected : ''
  const view = useMemo(() => (!health ? null : current ? layout(health, current) : overviewLayout(apps)),
    [health, current, apps])
  const app = apps.find((t) => t.id === current) || apps.find((t) => t.members.has(current))

  if (!api) return <Login onLogin={onLogin} />

  const incidents = health ? [...health.nodes.values()].filter((n) => n.state === 'crit').length : 0
  const warnings = health ? [...health.nodes.values()].filter((n) => n.state === 'warn').length : 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src="/zabbix-icon.png" alt="Zabbix" />
          <div>
            <h1>Service flow</h1>
            <span className="subtitle">APM · Zabbix 8.0</span>
          </div>
        </div>
        <div className="controls">
          <label>
            Application
            <select value={current} onChange={(e) => setSelected(e.target.value)}>
              <option value="">All applications (overview)</option>
              {apps.map((t) => (
                <optgroup key={t.id} label={t.id}>
                  {t.services.map((s) => <option key={s} value={s}>{s === t.id ? `${s} (entry)` : s}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            Time range
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[5, 15, 30, 60].map((m) => <option key={m} value={m}>Last {m} min</option>)}
            </select>
          </label>
        </div>
        <div className="status">
          <span className={`pill ${incidents ? 'crit' : 'ok'}`}>{incidents} incident{incidents === 1 ? '' : 's'}</span>
          <span className={`pill ${warnings ? 'warn' : 'ok'}`}>{warnings} warning{warnings === 1 ? '' : 's'}</span>
          <span className="updated">{updated ? `Updated ${clock(updated)}` : 'Loading…'}</span>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <nav className="crumbs">
        <button className={`crumb ${current ? '' : 'here'}`} onClick={() => setSelected('')}>Overview</button>
        {app && <span className="sep">›</span>}
        {app && <button className={`crumb ${current === app.id ? 'here' : ''}`} onClick={() => setSelected(app.id)}>{app.id}</button>}
        {app && current !== app.id && <span className="sep">›</span>}
        {app && current !== app.id && <button className="crumb here">{current}</button>}
        {!current && apps.length > 0 && <span className="muted">{apps.length} applications · click one to open its flow</span>}
      </nav>

      <main className="canvas">
        {view && view.nodes.length > 0 && (
          <FlowMap view={view} selected={current} frontend={api.frontend} onSelect={setSelected} />
        )}
        {health && apps.length === 0 && (
          <div className="empty">No spans in the last {minutes} minutes. Run multi_app.py to generate traffic.</div>
        )}
      </main>

      <footer className="legend">
        <span><i className="dot ok" /> OK</span>
        <span><i className="dot warn" /> Warning / average</span>
        <span><i className="dot crit" /> Incident (high or disaster)</span>
        <span><i className="dot unknown" /> No Zabbix host</span>
        <span className="hint">Hover a service or a connection to see metrics and traces · click a service to focus on it, click again to go back to the overview</span>
      </footer>
    </div>
  )
}
