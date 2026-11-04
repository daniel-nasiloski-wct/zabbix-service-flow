import React from 'react'
import { createRoot } from 'react-dom/client'
import Dashboard from './Dashboard.jsx'
import { setI18n } from './i18n.js'
import './styles.css'

// Montado dentro da página do Zabbix (APM → APM dashboard). A view do módulo cria o
// #service-dashboard-root e define window.SERVICE_DASHBOARD (URLs das ações, CSRF, permissões,
// idioma do usuário e dicionário de textos).
function mount() {
  const root = document.getElementById('service-dashboard-root')
  const config = window.SERVICE_DASHBOARD || {}
  setI18n(config.i18n, config.lang)
  if (root) createRoot(root).render(<Dashboard config={config} />)
}

// O filtro do Zabbix (CFilter) nasce escondido e só aparece no "document ready" dele; montar o mapa
// antes disso faz a página pular quando o filtro surge. Entrando na mesma fila do jQuery, o mapa é
// montado depois do filtro já estar no lugar. No harness (sem jQuery) monta direto.
if (window.jQuery) window.jQuery(mount)
else mount()
