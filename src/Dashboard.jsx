import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { filterQuery, get, post } from './api.js'
import { applyHealth, layout, overviewLayout, sortApps, tenants, OVERVIEW_COL_W } from './graph.js'
import { t } from './i18n.js'
import FlowMap, { MIN_SCALE, NODE_W, PAD } from './FlowMap.jsx'
import Select from './Select.jsx'
import NoData from './NoData.jsx'

const DEFAULT_WINDOWS = [5, 15, 30, 60]
const MIN_HEIGHT = 480
// Animação de reacomodação dos cards durante o arrasto (a troca de tela normal usa a do FlowMap).
const REORDER_MS = 300

// Estado na URL da própria página do Zabbix: zabbix.php?action=servicedashboard.view&service=…&minutes=…
function readUrl(config) {
  const windows = config.windows || DEFAULT_WINDOWS
  const params = new URLSearchParams(location.search)
  const minutes = Number(params.get('minutes'))
  return {
    service: params.get('service') || config.service || '',
    minutes: windows.includes(minutes) ? minutes : (windows.includes(config.minutes) ? config.minutes : 15),
  }
}

function writeUrl(service, minutes, push) {
  const url = new URL(location.href)
  if (!url.searchParams.get('action')) url.searchParams.set('action', 'servicedashboard.view')
  if (service) url.searchParams.set('service', service)
  else url.searchParams.delete('service')
  url.searchParams.set('minutes', String(minutes))
  if (url.href === location.href) return
  if (push) history.pushState(null, '', url)
  else history.replaceState(null, '', url)
}

// Contêiner que rola a página: no Zabbix é o .wrapper (o body tem altura fixa); no harness, a janela.
function scrollParent(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if (o === 'auto' || o === 'scroll' || o === 'overlay') return n
  }
  return null
}

// O mapa ocupa o que sobra da área visível abaixo do topo dele, descontando o que vem depois (rodapé
// do Zabbix). Recalcula quando o filtro do Zabbix aparece, recolhe ou expande, em resize e no kiosk.
function useFillViewport(ref) {
  const [fill, setFill] = useState({ height: null, overlap: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const container = scrollParent(el)
    const measure = () => {
      const r = el.getBoundingClientRect()
      const visibleBottom = container
        ? container.getBoundingClientRect().top + container.clientTop + container.clientHeight
        : window.innerHeight
      // Espaço ocupado abaixo do mapa: altura do que vem depois dele em cada nível até o contêiner (o
      // rodapé do Zabbix) mais o padding inferior de cada ancestral. Conta só o que começa abaixo do
      // mapa, porque a barra lateral também é "irmã" do conteúdo no DOM, mas fica ao lado. Margens
      // ficam de fora: o rodapé tem margin-top:auto, que o navegador resolve como a folga do flex.
      // O rodapé do Zabbix tem 55 px de padding em cima (espaço vazio): o mapa avança sobre esse
      // padding com margem negativa (overlap), senão sobra um buraco entre o mapa e o rodapé.
      const px = (v) => parseFloat(v) || 0
      let below = 0
      let overlap = 0
      for (let n = el; n && n !== container && n !== document.body; n = n.parentElement) {
        for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
          const b = s.getBoundingClientRect()
          // Começa abaixo do topo do mapa = vem depois dele no fluxo (não pode ser a parte de baixo
          // do mapa, porque com o overlap o rodapé começa dentro da área do mapa).
          if (b.height > 0 && b.top >= r.top) {
            below += b.height
            overlap += px(getComputedStyle(s).paddingTop)
          }
        }
        if (n.parentElement) {
          const cs = getComputedStyle(n.parentElement)
          below += px(cs.paddingBottom) + px(cs.borderBottomWidth)
        }
      }
      const height = Math.max(MIN_HEIGHT, Math.floor(visibleBottom - r.top - below + overlap - 10))
      setFill((f) => (f.height === height && f.overlap === overlap ? f : { height, overlap }))
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = new ResizeObserver(measure)
    ro.observe(container || document.documentElement)
    // Tudo o que divide o contêiner com o mapa (filtro, cabeçalho, rodapé) muda a altura disponível.
    for (let n = el; n && n !== container && n !== document.body; n = n.parentElement) {
      for (const sibling of n.parentElement ? n.parentElement.children : []) ro.observe(sibling)
    }
    return () => {
      window.removeEventListener('resize', measure)
      ro.disconnect()
    }
  }, [ref])
  return fill
}

// Menu de ações do cabeçalho (botão que o PHP cria ao lado do kiosk, como no dashboard): abre o
// menuPopup do próprio Zabbix. O callback fica num ref para o menu enxergar sempre o estado atual.
function useActionsMenu(sections) {
  const latest = useRef(sections)
  latest.current = sections
  useEffect(() => {
    const btn = document.getElementById('service-dashboard-actions')
    const $ = window.jQuery
    if (!btn || !$ || !$.fn.menuPopup) return undefined
    // Pelo jQuery: o menuPopup lê event.originalEvent, que só existe no evento do jQuery.
    const open = function (e) {
      e.preventDefault()
      $(this).menuPopup(latest.current(), e)
    }
    $(btn).on('click', open)
    return () => $(btn).off('click', open)
  }, [])
}

// Diálogo de confirmação no estilo do Zabbix (overlayDialogue do core); no harness, confirm() nativo.
function confirmDialog({ title, lines, confirmLabel, onConfirm }) {
  if (typeof window.overlayDialogue !== 'function') {
    if (window.confirm(lines.join('\n\n'))) onConfirm()
    return
  }
  // Largura fixa e quebra de linha explícitas: o diálogo do Zabbix dimensiona pelo conteúdo e cortava
  // o texto longo à direita.
  const content = document.createElement('div')
  content.style.cssText = 'width: 440px; max-width: 80vw; white-space: normal; line-height: 1.5'
  for (const text of lines) {
    const p = document.createElement('p')
    p.textContent = text
    p.style.margin = '0 0 8px'
    content.appendChild(p)
  }
  window.overlayDialogue({
    title,
    content,
    buttons: [
      { title: t('Cancel'), cancel: true, class: 'btn-alt', action: () => {} },
      { title: confirmLabel, focused: true, action: onConfirm },
    ],
  })
}

// Mapa de serviços. Os dados vêm prontos do módulo (servicedashboard.data), que coleta do Zabbix com
// a sessão do usuário e compartilha a coleta entre todos os navegadores.
export default function Dashboard({ config }) {
  const windows = config.windows || DEFAULT_WINDOWS
  const [{ service: selected, minutes }, setRoute] = useState(() => readUrl(config))
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [reload, setReload] = useState(0)
  const pageRef = useRef(null)
  const { height, overlap } = useFillViewport(pageRef)
  // Largura do mapa: define quantas colunas a visão geral tem sem encolher os cards abaixo do mínimo.
  const canvasRef = useRef(null)
  const [canvasWidth, setCanvasWidth] = useState(0)
  useLayoutEffect(() => {
    const el = canvasRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // A última coluna só precisa da largura do card, não do passo inteiro da grade.
  const maxCols = canvasWidth
    ? Math.max(1, Math.floor((canvasWidth - PAD * 2 - NODE_W * MIN_SCALE) / (OVERVIEW_COL_W * MIN_SCALE)) + 1)
    : Infinity
  // Filtro por atributos aplicado no formulário do Zabbix acima do mapa (vem do perfil do usuário).
  const filterQs = useMemo(() => filterQuery(config.filter), [config.filter])
  const conditions = config.filtered
    ? (config.filter.resource_attributes?.length || 0) + (config.filter.span_attributes?.length || 0)
    : 0

  useEffect(() => {
    const onPop = () => setRoute(readUrl(config))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [config])

  const setSelected = useCallback((svc) => {
    setRoute((r) => {
      if (r.service === svc) return r
      writeUrl(svc, r.minutes, true)
      return { ...r, service: svc }
    })
  }, [])
  const setMinutes = useCallback((m) => {
    setRoute((r) => {
      writeUrl(r.service, m, false)
      return { ...r, minutes: m }
    })
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await get(`${config.dataUrl}&minutes=${minutes}${filterQs}`)
        if (!alive) return
        setData({ ...d, minutes })
        setError(null)
      } catch (e) {
        if (alive) setError(e.message)
      }
    }
    load()
    const timer = setInterval(load, config.refreshMs || 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [config.dataUrl, config.refreshMs, filterQs, minutes, reload])

  // Dados de outra janela (troca em andamento) não são mostrados.
  const shown = data && data.minutes === minutes ? data : null
  const health = useMemo(() => (shown ? applyHealth(shown.graph, shown) : null), [shown])
  const services = useMemo(
    () => (health ? [...health.nodes.values()].filter((n) => n.kind === 'service').map((n) => n.id).sort() : []),
    [health],
  )

  // Modo de edição (menu "Edit", como o modo de edição do dashboard): X nos cards, arrastar e soltar
  // na grade da visão geral, "Save" grava a ordem no módulo e "Cancel" descarta. `draft` é a ordem em
  // edição; fora dela vale a ordem salva (data.order) e, para o que não está nela, a padrão.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const savedOrder = shown?.order || []
  const apps = useMemo(() => {
    const base = health ? tenants(health) : []
    return sortApps(base, editing && draft ? draft : savedOrder)
  }, [health, savedOrder, editing, draft])
  const appsRef = useRef(apps)
  appsRef.current = apps
  const current = services.includes(selected) ? selected : ''
  const view = useMemo(
    () => (!health ? null : current ? layout(health, current) : overviewLayout(apps, maxCols, editing ? REORDER_MS : undefined)),
    [health, current, apps, maxCols, editing],
  )
  const app = apps.find((t) => t.id === current) || apps.find((t) => t.members.has(current))

  const startEditing = () => {
    setDraft(appsRef.current.map((a) => a.id))
    setEditing(true)
  }
  const stopEditing = () => {
    setEditing(false)
    setDraft(null)
  }
  const reorder = useCallback((id, index) => {
    setDraft((d) => {
      // Parte do rascunho atual (não do último render): movimentos seguidos não se atropelam.
      const known = new Set(d || [])
      const ids = [...(d || []), ...appsRef.current.map((a) => a.id).filter((x) => !known.has(x))].filter((x) => x !== id)
      ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id)
      return ids
    })
  }, [])
  const save = async () => {
    const order = draft || appsRef.current.map((a) => a.id)
    try {
      await post(config.layoutUrl, { order, _csrf_token: config.csrfLayout })
      // A ordem salva já vale nos dados atuais: sem isso os cards voltavam à ordem antiga ao sair do
      // modo de edição e deslizavam de novo quando a resposta nova do servidor chegava.
      setData((d) => (d ? { ...d, order } : d))
      stopEditing()
      setReload((n) => n + 1)
    } catch (e) {
      setError(t('Could not save the layout: %1$s', e.message))
    }
  }

  // Cabeçalho: fora da edição, menu + kiosk; na edição, Save + Cancel (listas que o PHP cria).
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const viewActions = document.querySelector('#service-dashboard-control .js-sd-view-actions')
    const editActions = document.querySelector('#service-dashboard-control .js-sd-edit-actions')
    const saveBtn = document.getElementById('service-dashboard-save')
    const cancelBtn = document.getElementById('service-dashboard-cancel')
    if (!viewActions || !editActions || !saveBtn || !cancelBtn) return undefined
    viewActions.style.display = editing ? 'none' : ''
    editActions.style.display = editing ? '' : 'none'
    const onSave = () => saveRef.current()
    const onCancel = (e) => { e.preventDefault(); stopEditing() }
    saveBtn.addEventListener('click', onSave)
    cancelBtn.addEventListener('click', onCancel)
    return () => {
      saveBtn.removeEventListener('click', onSave)
      cancelBtn.removeEventListener('click', onCancel)
    }
  }, [editing])
  useActionsMenu(() => [{
    label: t('Actions'),
    items: [{ label: t('Edit'), disabled: appsRef.current.length === 0, clickCallback: startEditing }],
  }])

  // Remover do mapa (X do modo de edição): a aplicação leva os membros que nenhuma outra aplicação usa;
  // o serviço leva os bancos/externos dele (um nó por chamador, id terminado em @serviço).
  const askRemove = (node) => {
    const target = apps.find((a) => a.id === node.id)
    const isApp = !current && target
    let ids
    if (isApp) {
      const shared = new Set(apps.filter((a) => a !== target).flatMap((a) => [...a.members]))
      ids = [...target.members].filter((id) => !shared.has(id))
    } else {
      ids = [node.id, ...[...health.nodes.keys()].filter((id) => id.endsWith(`@${node.id}`))]
    }
    confirmDialog({
      title: isApp ? t('Remove application') : t('Remove service'),
      confirmLabel: t('Remove'),
      lines: [
        isApp ? t('Remove application "%1$s" from the map?', node.id) : t('Remove service "%1$s" from the map?', node.id),
        isApp
          ? t('Its services, databases and external calls leave the map. Services shared with other applications stay.')
          : t('The service, its connections, databases and external calls leave the map.'),
        isApp
          ? t('If the application is discovered again in new traces, it is recreated automatically, with all its entities.')
          : t('If the service is discovered again in new traces, it is recreated automatically, with all its entities.'),
        t('Hosts, items and triggers in Zabbix are not changed.'),
      ],
      onConfirm: async () => {
        try {
          await post(config.removeUrl, { ids, _csrf_token: config.csrf })
          if (!isApp && node.id === current) setSelected('')
          setDraft((d) => (d ? d.filter((id) => id !== node.id) : d))
          setReload((n) => n + 1)
        } catch (e) {
          setError(e.message)
        }
      },
    })
  }

  // Controles (só os dois seletores): na linha de navegação do Zabbix (a mesma do botão Filter), quando
  // ela existe; no kiosk e no harness, no topo do próprio mapa.
  const navTarget = document.getElementById('service-dashboard-nav')
  const controls = (
    <div className={navTarget ? 'nav-controls' : 'topbar'}>
      <label>
        {t('Application')}
        <Select
          className="wide" value={current} onChange={setSelected}
          options={[
            { value: '', label: t('All applications (overview)') },
            ...apps.map((a) => ({
              group: a.id,
              options: a.services.map((s) => ({ value: s, label: s === a.id ? `${s} (entry)` : s })),
            })),
          ]}
        />
      </label>
      <label>
        {t('Time range')}
        <Select
          value={minutes} onChange={(m) => setMinutes(Number(m))}
          options={windows.map((m) => ({ value: m, label: t('Last %1$s minutes', m) }))}
        />
      </label>
    </div>
  )

  // Voltar um nível: serviço → entrada da aplicação; aplicação → visão geral.
  const back = app ? (current === app.id ? '' : app.id) : ''
  const backLabel = back ? back : t('Overview')

  return (
    <div className={`page ${editing ? 'editing' : ''}`} ref={pageRef}
      style={height ? { height, marginBottom: overlap ? -overlap : 0 } : undefined}>
      {navTarget ? createPortal(controls, navTarget) : controls}

      {error && <div className="error">{error}</div>}

      <div className="canvas" ref={canvasRef}>
        {app && (
          <div className="context">
            <button className="back" onClick={() => setSelected(back)} title={t('Back to %1$s', backLabel)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
              {backLabel}
            </button>
            <span className="where">
              <b>{app.id}</b>
              {current !== app.id && <><span className="sep">›</span><b>{current}</b></>}
            </span>
          </div>
        )}
        {view && view.nodes.length > 0 && (
          <FlowMap view={view} selected={current} frontend={config.frontend || ''} onSelect={setSelected}
            editing={editing} onRemove={askRemove} onReorder={reorder} />
        )}
        {health && apps.length === 0 && !error && (
          <NoData title={t('No data found')}>
            {conditions > 0
              ? t('No APM span matches the attribute filter in the selected time range. Change the filter above or press Reset to see everything.')
              : t('No APM traces in the selected time range and no host with the apm.requests item. Services appear here as soon as the applications send traces to the Zabbix proxy.')}
          </NoData>
        )}
      </div>
    </div>
  )
}
