import React, { useEffect, useRef, useState } from 'react'

// Dropdown próprio no lugar do <select>: a lista nativa do macOS não aceita estilo.
// options: [{ value, label }] ou grupos [{ group, options: [{ value, label }] }].
export default function Select({ value, onChange, options, className = '' }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const root = useRef(null)
  const list = useRef(null)

  const flat = options.flatMap((o) => (o.group ? o.options : [o]))
  const index = flat.findIndex((o) => String(o.value) === String(value))
  const current = flat[index]

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!root.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // Mantém a opção ativa visível ao navegar pelo teclado.
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const show = () => { setActive(index); setOpen(true) }
  const pick = (o) => { setOpen(false); if (String(o.value) !== String(value)) onChange(o.value) }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return show()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.min(flat.length - 1, Math.max(0, i + step)))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!open) show()
      else if (flat[active]) pick(flat[active])
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
    }
  }

  let i = -1
  const renderOption = (o) => {
    const n = ++i
    const selected = n === index
    return (
      <li
        key={o.value} data-i={n} role="option" aria-selected={selected}
        className={`select-option${selected ? ' selected' : ''}${n === active ? ' active' : ''}`}
        onMouseEnter={() => setActive(n)}
        onClick={(e) => { e.preventDefault(); pick(o) }}
      >
        {o.label}
      </li>
    )
  }

  return (
    <div className={`select ${open ? 'open' : ''} ${className}`} ref={root}>
      <button
        type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open}
        onClick={(e) => { e.preventDefault(); open ? setOpen(false) : show() }}
        onKeyDown={onKeyDown}
      >
        <span>{current ? current.label : ''}</span>
      </button>
      <ul className="select-menu" role="listbox" ref={list}>
        {options.map((o) => (o.group ? (
          <li key={`g-${o.group}`} role="presentation">
            <div className="select-group">{o.group}</div>
            <ul role="group">{o.options.map(renderOption)}</ul>
          </li>
        ) : renderOption(o)))}
      </ul>
    </div>
  )
}
