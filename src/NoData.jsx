import React from 'react'

// Caixa de "sem dados" no estilo do Zabbix.
export default function NoData({ title, children }) {
  return (
    <div className="no-data">
      <svg viewBox="0 0 48 48" className="no-data-icon" aria-hidden="true">
        <ellipse cx="24" cy="11" rx="15" ry="5" />
        <path d="M9 11v13c0 2.8 6.7 5 15 5s15-2.2 15-5V11M9 24v13c0 2.8 6.7 5 15 5s15-2.2 15-5V24" />
      </svg>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  )
}
