import React, { useState } from 'react'
import { Zabbix } from './zabbix.js'

export default function Login({ onLogin }) {
  const [url, setUrl] = useState(import.meta.env.VITE_ZABBIX_URL || 'http://localhost/api_jsonrpc.php')
  const [username, setUsername] = useState('Admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onLogin(await Zabbix.login(url, username, password))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="brand">
          <img className="logo" src="/zabbix-icon.png" alt="Zabbix" />
          <div>
            <h1>Service flow</h1>
            <span className="subtitle">Sign in with a Zabbix user</span>
          </div>
        </div>
        <label>Zabbix API<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        </label>
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
