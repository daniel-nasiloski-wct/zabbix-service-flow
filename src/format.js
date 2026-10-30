const nf = (digits) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits })

export const num = (n, digits = 1) => nf(digits).format(Number(n) || 0)

export function dur(seconds) {
  const s = Number(seconds) || 0
  if (s < 1) return `${num(s * 1000, 0)} ms`
  return `${num(s, 2)} s`
}

export const pct = (n) => `${num(n, 1)}%`

export function since(unixSeconds) {
  const diff = Math.max(0, Date.now() / 1000 - Number(unixSeconds))
  if (diff < 60) return `${Math.round(diff)} s ago`
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  return `${num(diff / 3600, 1)} h ago`
}

export const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour12: false })

export const SEVERITY = {
  0: 'Not classified', 1: 'Information', 2: 'Warning', 3: 'Average', 4: 'High', 5: 'Disaster',
}

export const STATE_LABEL = { ok: 'OK', warn: 'Warning', crit: 'Incident', unknown: 'No Zabbix host' }
