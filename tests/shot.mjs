// Screenshot de uma página com o Chrome headless, via protocolo DevTools (sem dependências; Node 22+).
// Serve para ver o mapa dentro do Zabbix do lab com a sessão de um cookie, inclusive com hover, e
// imprime erros de console/JS da página.
//
// Uso: node tests/shot.mjs <url> <saida.png> [--cookie nome=valor] [--domain localhost] [--width 1600]
//        [--height 1000] [--wait 2500] [--hover x,y] [--click x,y] [--eval "js"] [--theme dark-blue-theme]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2)
const url = args.shift()
const out = args.shift()
const opt = { width: 1600, height: 1000, wait: 2500, cookie: [], domain: 'localhost' }
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '')
  if (k === 'cookie') opt.cookie.push(args[i + 1])
  else opt[k] = args[i + 1]
}
if (!url || !out) {
  console.error('uso: node tests/shot.mjs <url> <saida.png> [opções]')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'sd-shot-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', `--window-size=${opt.width},${opt.height}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m) resolve(m[1])
  })
  chrome.on('exit', () => reject(new Error('Chrome saiu antes de abrir o DevTools')))
  setTimeout(() => reject(new Error('DevTools não respondeu')), 15000)
})

const ws = new WebSocket(wsUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let nextId = 1
const pending = new Map()
const events = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    const { ok, err } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? err(new Error(JSON.stringify(msg.error))) : ok(msg.result)
  } else if (msg.method) {
    events.push(msg)
  }
}
const send = (method, params = {}, sessionId) => new Promise((ok, err) => {
  const id = nextId++
  pending.set(id, { ok, err })
  ws.send(JSON.stringify({ id, method, params, sessionId }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (method, params) => send(method, params, sessionId)
  await s('Page.enable')
  await s('Runtime.enable')
  await s('Log.enable')
  await s('Network.enable')
  await s('Emulation.setDeviceMetricsOverride', { width: Number(opt.width), height: Number(opt.height), deviceScaleFactor: 1, mobile: false })
  for (const c of opt.cookie) {
    const eq = c.indexOf('=')
    await s('Network.setCookie', { name: c.slice(0, eq), value: c.slice(eq + 1), domain: opt.domain, path: '/' })
  }
  await s('Page.navigate', { url })
  await sleep(Number(opt.wait))
  if (opt.theme) {
    const dark = ['dark-theme', 'dark-blue-theme', 'dark-classic-theme', 'hc-dark'].includes(opt.theme)
    await s('Runtime.evaluate', { expression: `document.documentElement.setAttribute('theme', '${opt.theme}'); document.documentElement.setAttribute('color-scheme', '${dark ? 'dark' : 'light'}')` })
    await sleep(300)
  }
  if (opt.eval) {
    const r = await s('Runtime.evaluate', { expression: opt.eval, awaitPromise: true, returnByValue: true })
    if (r.result?.value !== undefined) console.log('eval:', JSON.stringify(r.result.value))
    await sleep(Number(opt.evalWait || 400))
  }
  if (opt.click) {
    const [x, y] = opt.click.split(',').map(Number)
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(1200)
  }
  if (opt.hover) {
    const [x, y] = opt.hover.split(',').map(Number)
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(Number(opt.hoverWait || 2600))
  }
  // Arrasto com o mouse de verdade (pointer events do navegador): --drag x1,y1,x2,y2 em passos.
  if (opt.drag) {
    const [x1, y1, x2, y2] = opt.drag.split(',').map(Number)
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 })
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 })
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: 'left', buttons: 1 })
      await sleep(40)
    }
    await sleep(400)
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
    await sleep(Number(opt.dragWait || 800))
  }
  if (opt.evalAfter) {
    const r = await s('Runtime.evaluate', { expression: opt.evalAfter, awaitPromise: true, returnByValue: true })
    if (r.result?.value !== undefined) console.log('evalAfter:', JSON.stringify(r.result.value))
  }
  const { data } = await s('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(data, 'base64'))
  const problems = events.filter((e) => e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
    || (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)))
  for (const e of problems) {
    if (e.method === 'Runtime.exceptionThrown') console.log('JS exception:', e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
    else if (e.method === 'Log.entryAdded') console.log(`console ${e.params.entry.level}:`, e.params.entry.text, e.params.entry.url || '')
    else console.log(`console.${e.params.type}:`, e.params.args.map((a) => a.value ?? a.description).join(' '))
  }
  console.log(`screenshot: ${out} (${problems.length} erro(s)/aviso(s) de console)`)
} finally {
  ws.close()
  const exited = new Promise((r) => chrome.once('exit', r))
  chrome.kill()
  await Promise.race([exited, sleep(3000)])
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
