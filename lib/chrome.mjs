import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright-core'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export const HOME_DIR = process.env.VENICE_WEB_HOME ?? (process.platform === 'darwin'
  ? path.join(homedir(), 'Library', 'Application Support', 'venice-web')
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'venice-web')
    : path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'venice-web'))

export function loopbackEndpoint(value) {
  const url = new URL(value)
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !url.port) throw new Error('cdpEndpoint must be a local http://127.0.0.1:PORT or ws://127.0.0.1:PORT/devtools/browser/ID address')
  if (url.protocol === 'http:' && url.pathname !== '/') throw new Error('HTTP cdpEndpoint must contain only a loopback origin')
  if (url.protocol === 'ws:' && !url.pathname.startsWith('/devtools/browser/')) throw new Error('WebSocket cdpEndpoint must identify a browser')
  return url.toString().replace(/\/$/, '')
}

async function executable(explicit) {
  if (explicit) { await access(explicit, constants.F_OK); return explicit }
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
  for (const candidate of candidates) { try { await access(candidate, constants.F_OK); return candidate } catch {} }
  throw new Error('Chrome/Chromium not found. Set plugin option chromePath to the browser executable.')
}

export function createChrome(options = {}) {
  const root = path.resolve(options.dataDir ?? HOME_DIR)
  const profile = path.join(root, 'chrome-profile')
  const external = options.cdpEndpoint ? loopbackEndpoint(options.cdpEndpoint) : null
  let connection, connecting, starting, idleTimer
  function idleDisconnect() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { const current = connection; connection = null; current?.close().catch(() => {}) }, 5000)
    idleTimer.unref?.()
  }
  async function ownedEndpoint() {
    try {
      const { port, socketPath } = JSON.parse(await readFile(path.join(root, 'endpoint.json'), 'utf8'))
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !socketPath?.startsWith('/devtools/browser/')) return null
      const endpoint = `http://127.0.0.1:${port}`
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })
      const info = await response.json()
      if (!info.webSocketDebuggerUrl?.endsWith(socketPath)) return null
      return endpoint
    } catch { return null }
  }
  async function launch() {
    await mkdir(profile, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700).catch(() => {})
    await chmod(profile, 0o700).catch(() => {})
    const lock = path.join(root, 'launch.lock')
    let haveLock = false
    try {
      try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); haveLock = true }
      catch (e) {
        if (e.code !== 'EEXIST') throw e
        let alive = true
        try { const pid = Number(await readFile(lock, 'utf8')); if (!pid) alive = false; else process.kill(pid, 0) } catch (error) { if (error.code !== 'EPERM') alive = false }
        if (!alive) { await unlink(lock).catch(() => {}); return launch() }
        for (let i = 0; i < 80; i++) { const endpoint = await ownedEndpoint(); if (endpoint) return endpoint; await pause(250) }
        throw new Error('Another process is starting Venice Chrome; retry shortly.')
      }
      const existing = await ownedEndpoint()
      if (existing) return existing
      const binary = await executable(options.chromePath ?? process.env.VENICE_WEB_CHROME)
      if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('A desktop display is required for Chrome login. Set cdpEndpoint to a browser you started on a desktop.')
      // Launch normal installed Chrome, without Playwright automation flags or a copied user profile.
      const port = await new Promise((resolve, reject) => {
        const socket = createServer(); socket.on('error', reject)
        socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) })
      })
      const child = spawn(binary, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: false })
      let launchError
      child.on('error', error => { launchError = error })
      child.unref()
      for (let i = 0; i < 80; i++) {
        if (launchError) throw launchError
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
          const info = await response.json()
          const ws = new URL(info.webSocketDebuggerUrl)
          if (ws.pathname.startsWith('/devtools/browser/')) {
            await writeFile(path.join(root, 'endpoint.json'), JSON.stringify({ port, socketPath: ws.pathname }), { mode: 0o600 })
            return `http://127.0.0.1:${port}`
          }
        } catch {}
        await pause(250)
      }
      throw new Error('Chrome did not expose its local endpoint. Close only the plugin Chrome window and retry login.')
    } finally { if (haveLock) await unlink(lock).catch(() => {}) }
  }
  async function endpoint({ open = false } = {}) {
    if (external) return external
    const existing = await ownedEndpoint()
    if (existing) return existing
    if (!open) throw new Error('Venice Chrome is not running. Run magpie plugin login venice-web to open its persistent browser.')
    starting ??= launch().finally(() => { starting = null })
    return starting
  }
  async function browser({ open = false } = {}) {
    if (connection?.isConnected()) return connection
    connecting ??= (async () => {
      connection = await chromium.connectOverCDP(await endpoint({ open }), { timeout: 10000 })
      return connection
    })().finally(() => { connecting = null })
    return connecting
  }
  function existingPage(b) {
    const pages = b.contexts().flatMap(c => c.pages()).filter(p => {
      try { return new URL(p.url()).origin === 'https://venice.ai' } catch { return false }
    })
    if (pages.length > 1) {
      const agent = pages.filter(p => new URL(p.url()).pathname === '/chat/agent')
      if (agent.length === 1) return agent[0]
      if (!external) return agent[0] ?? pages[0]
      throw new Error('Keep one Venice chat tab in the connected Chrome profile to avoid ambiguous account selection.')
    }
    return pages[0]
  }
  async function page({ open = false } = {}) {
    const b = await browser({ open })
    const existing = existingPage(b)
    if (existing) return existing
    if (!open) throw new Error('Open https://venice.ai/chat/agent in the connected Chrome and keep the tab open.')
    // Model, quota and refresh hooks can run in different plugin instances/processes.
    // Keep the lock through navigation so another caller cannot mistake a pending tab for absence.
    const lock = path.join(root, 'page.lock')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const deadline = Date.now() + 60000
    while (true) {
      try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        let ownerAlive = true
        try { const pid = Number(await readFile(lock, 'utf8')); if (pid > 0) process.kill(pid, 0) }
        catch (e) { if (e.code === 'ESRCH') ownerAlive = false }
        if (!ownerAlive) { await unlink(lock).catch(() => {}); continue }
        if (Date.now() > deadline) throw new Error('Timed out waiting for the Venice page to open')
        await pause(100)
      }
    }
    try {
      // Refresh page inventory after acquiring the cross-process lock.
      const found = existingPage(b)
      if (found) return found
      const context = b.contexts()[0]
      if (!context) throw new Error('Chrome has no browser context')
      const tab = context.pages().find(p => p.url() === 'about:blank') ?? await context.newPage()
      await tab.goto('https://venice.ai/chat/agent', { waitUntil: 'domcontentloaded', timeout: 45000 })
      return tab
    } finally { await unlink(lock).catch(() => {}) }
  }
  return {
    root, profile,
    async exportCookies() {
      const tab = await page()
      const context = tab.context()
      return { cookies: await context.cookies(['https://clerk.venice.ai/', 'https://venice.ai/', 'https://outerface.venice.ai/']), userAgent: await tab.evaluate(() => navigator.userAgent) }
    },
    async open() {
      await endpoint({ open: true })
      const b = await browser({ open: true })
      await b.contexts()[0]?.pages()[0]?.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
      await page({ open: true })
      idleDisconnect()
      return await endpoint()
    },
    async evaluate(expression) {
      clearTimeout(idleTimer)
      try {
        const tab = await page({ open: !external })
        await tab.waitForFunction(() => window.Clerk?.loaded === true, null, { timeout: 20000 }).catch(() => {})
        if (new URL(tab.url()).origin !== 'https://venice.ai') throw new Error('Venice page changed origin')
        const result = await tab.evaluate(expression)
        try { return JSON.parse(result) } catch { throw new Error('Chrome returned an invalid Venice bridge response') }
      } finally { idleDisconnect() }
    },
    async disconnect() { clearTimeout(idleTimer); if (connection?.isConnected()) await connection.close(); connection = null },
  }
}
