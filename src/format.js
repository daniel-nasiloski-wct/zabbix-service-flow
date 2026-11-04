import { getLocale, t } from './i18n.js'

// Números e horas no idioma do usuário do Zabbix (lang do perfil); textos pelo dicionário do módulo.
const nf = (digits) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: digits })

export const num = (n, digits = 1) => nf(digits).format(Number(n) || 0)

export function dur(seconds) {
  const s = Number(seconds) || 0
  if (s < 1) return t('%1$s ms', num(s * 1000, 0))
  return t('%1$s s', num(s, 2))
}

export const pct = (n) => `${num(n, 1)}%`

export function since(unixSeconds) {
  const diff = Math.max(0, Date.now() / 1000 - Number(unixSeconds))
  if (diff < 60) return t('%1$s s ago', Math.round(diff))
  if (diff < 3600) return t('%1$s min ago', Math.round(diff / 60))
  if (diff < 86400) return t('%1$s h ago', num(diff / 3600, 1))
  return t('%1$s d ago', num(diff / 86400, 1))
}

export const clock = (ms) => new Date(ms).toLocaleTimeString(getLocale(), { hour12: false })
export const dateTime = (ms) => new Date(ms).toLocaleString(getLocale(), { hour12: false })

const SEVERITY = ['Not classified', 'Information', 'Warning', 'Average', 'High', 'Disaster']
export const severityLabel = (priority) => t(SEVERITY[Number(priority)] || SEVERITY[0])

const STATE = { ok: 'OK', warn: 'Warning', crit: 'Incident', unknown: 'No Zabbix host' }
export const stateLabel = (state) => t(STATE[state] || state)
