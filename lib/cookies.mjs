import { CookieJar } from 'tough-cookie'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HOME_DIR } from './chrome.mjs'
import { cookieFetch } from './http.mjs'

const CLERK = 'https://clerk.venice.ai'
const API = 'https://outerface.venice.ai'
const VERSION = '?__clerk_api_version=2026-05-12&_clerk_js_version=6.39.0'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const expired = message => Object.assign(new Error(message), { signIn: 'expired' })
const validHandle = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

export async function cookieJarFrom(input) {
  const jar = new CookieJar()
  let cookies
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch {
      // A Clerk request Cookie header can contain the only required long-lived credential.
      for (const pair of input.replace(/^cookie:\s*/i, '').split(';')) {
        const i = pair.indexOf('=')
        if (i > 0 && pair.slice(0, i).trim() === '__client') await jar.setCookie(`${pair.trim()}; Path=/; Secure; HttpOnly`, CLERK)
      }
      return jar
    }
  }
  cookies = Array.isArray(input) ? input : input?.cookies
  if (!Array.isArray(cookies)) throw new Error('Paste a JSON cookie export or the Cookie header from clerk.venice.ai containing __client.')
  if (cookies.length > 500) throw new Error('Too many cookies in export; export Venice cookies only.')
  for (const c of cookies) {
    const host = String(c.domain ?? '').replace(/^\./, '').toLowerCase()
    if (!['venice.ai', 'clerk.venice.ai', 'outerface.venice.ai'].includes(host)) continue
    if (typeof c.name !== 'string' || typeof c.value !== 'string' || /[\r\n;=]/.test(c.name) || /[\r\n;]/.test(c.value)) throw new Error('Invalid cookie export')
    const expires = c.expires ?? c.expirationDate
    const parts = [`${c.name}=${c.value}`, `Path=${c.path || '/'}`]
    if (!c.hostOnly && c.domain.startsWith('.') && !c.name.startsWith('__Host-')) parts.push(`Domain=${c.domain}`)
    if (c.secure !== false) parts.push('Secure')
    if (c.httpOnly) parts.push('HttpOnly')
    if (typeof expires === 'number' && expires > 0) parts.push(`Expires=${new Date(expires * 1000).toUTCString()}`)
    await jar.setCookie(parts.join('; '), `https://${host}${c.path || '/'}`)
  }
  return jar
}

export function createCookies(options = {}, dependencies = {}) {
  const root = path.resolve(options.dataDir ?? HOME_DIR, 'cookie-accounts')
  const send = dependencies.fetch ?? ((url, init) => cookieFetch(url, init, { nodePath: options.nodePath }))
  const now = dependencies.now ?? Date.now
  async function save(file, state) {
    const temporary = file + '.' + randomUUID() + '.tmp'
    try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await rename(temporary, file) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  const inProcessLocks = new Map()
  async function locked(handle, fn, { signal } = {}) {
    if (!validHandle(handle)) throw expired('Venice cookie account missing; import cookies in Magpie.')
    const queue = inProcessLocks.get(handle) ?? Promise.resolve()
    let release
    const next = new Promise(r => { release = r })
    inProcessLocks.set(handle, next)
    await queue.catch(() => {})
    try {
      const file = path.join(root, handle + '.json'), lock = file + '.lock'
      const end = now() + 45000
      await mkdir(root, { recursive: true, mode: 0o700 })
      while (true) {
        signal?.throwIfAborted()
        try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break }
        catch (e) {
          if (e.code !== 'EEXIST') throw e
          try { const owner = Number(await readFile(lock, 'utf8')); if (owner > 0) process.kill(owner, 0) }
          catch (error) { if (error.code === 'ESRCH') { await unlink(lock).catch(() => {}); continue } }
          if (now() > end) throw new Error('Timed out waiting for Venice cookie renewal')
          await pause(100)
        }
      }
      try {
        let state
        try { state = JSON.parse(await readFile(file, 'utf8')) }
        catch { throw expired('Venice cookie account is unavailable; import cookies again.') }
        const jar = await CookieJar.deserialize(state.jar)
        try { return await fn(state, jar) }
        finally { state.jar = await jar.serialize(); await save(file, state) }
      } finally { await unlink(lock).catch(() => {}) }
    } finally {
      release()
      if (inProcessLocks.get(handle) === next) inProcessLocks.delete(handle)
    }
  }
  async function http(state, jar, url, init = {}) {
    const address = new URL(url)
    if (![CLERK, API].includes(address.origin)) throw new Error('Unexpected Venice cookie destination')
    const headers = new Headers(init.headers)
    headers.set('user-agent', state.userAgent)
    headers.set('origin', 'https://venice.ai')
    headers.set('referer', 'https://venice.ai/')
    const cookie = await jar.getCookieString(url)
    if (cookie) headers.set('cookie', cookie)
    const response = await send(url, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30000) })
    for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url, { ignoreError: true })
    if (response.status === 403 && (response.headers.get('cf-mitigated') === 'challenge' || response.headers.get('content-type')?.includes('text/html'))) {
      await response.body?.cancel()
      throw Object.assign(new Error('Venice requires browser verification. Import fresh cookies from a new private login.'), { signIn: 'expired', challenge: true })
    }
    return response
  }
  async function json(response, action) {
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw expired(`Venice refused ${action}; import fresh cookies.`) }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Venice ${action} returned HTTP ${response.status}`) }
    try { return await response.json() } catch { throw new Error(`Venice ${action} returned invalid JSON`) }
  }
  async function discover(state, jar) {
    const client = await json(await http(state, jar, CLERK + '/v1/client' + VERSION), 'cookie login')
    const sessions = (client.response?.sessions ?? client.client?.sessions ?? []).filter(s => s.status === 'active')
    const selected = state.uid ? sessions.find(s => s.user?.id === state.uid) : sessions.find(s => s.id === client.response?.last_active_session_id) ?? sessions[0]
    if (!selected) throw expired('No active Venice session in cookies; import a fresh private login.')
    const user = selected.user
    state.sessionId = selected.id
    state.uid = user.id
    state.accountId = user.email_addresses?.find(e => e.id === user.primary_email_address_id)?.email_address ?? user.id
    state.sessionExpires = selected.expire_at
    return state
  }
  async function token(state, jar, { force = false, signal } = {}) {
    if (!force && state.access && state.expires > now() + 15000) return state.access
    const result = await json(await http(state, jar, `${CLERK}/v1/client/sessions/${encodeURIComponent(state.sessionId)}/tokens${VERSION}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'organization_id=&tab_state=focused&force_origin=true', signal,
    }), 'session renewal')
    if (typeof result.jwt !== 'string') throw expired('Venice session renewal returned no token; import cookies again.')
    let claims
    try { claims = JSON.parse(Buffer.from(result.jwt.split('.')[1], 'base64url').toString('utf8')) } catch { throw new Error('Venice returned an invalid session token') }
    if (claims.sub !== state.uid || claims.sid !== state.sessionId || !Number.isFinite(claims.exp)) throw expired('Venice token identity changed; import cookies again.')
    state.access = result.jwt; state.expires = claims.exp * 1000
    return result.jwt
  }
  return {
    root,
    async import(input, { userAgent = 'Mozilla/5.0', expectedUid } = {}) {
      if (/[\r\n]/.test(userAgent)) throw new Error('Invalid User-Agent')
      const jar = await cookieJarFrom(input)
      if (!(await jar.getCookies(CLERK)).some(c => c.key === '__client')) throw new Error('Missing Clerk __client cookie. Export cookies from clerk.venice.ai, not only venice.ai.')
      const state = { version: 1, userAgent, uid: expectedUid }
      await discover(state, jar)
      await token(state, jar, { force: true })
      const handle = randomUUID().replaceAll('-', '')
      await mkdir(root, { recursive: true, mode: 0o700 })
      state.jar = await jar.serialize(); await save(path.join(root, handle + '.json'), state)
      return { handle, uid: state.uid, accountId: state.accountId, expires: state.expires }
    },
    async refresh(auth, { force = false } = {}) {
      return locked(auth.refresh, async (state, jar) => {
        if (auth.uid && auth.uid !== state.uid) throw expired('Venice cookie account does not match Magpie login')
        await token(state, jar, { force })
        return { access: 'cookie-managed', refresh: auth.refresh, expires: state.expires, uid: state.uid, accountId: state.accountId, transport: 'cookie' }
      })
    },
    async request(auth, route, body, { signal, timeout = 240000 } = {}) {
      if (!['/api/inference/chat/agents/ad-hoc', '/api/v2/agents/configuration_options', '/api/app/models'].includes(route)) throw new Error('Unsupported Venice cookie route')
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
      return locked(auth.refresh, async (state, jar) => {
        if (auth.uid !== state.uid) throw expired('Venice cookie account does not match Magpie login')
        for (let attempt = 0; attempt < 2; attempt++) {
          const access = await token(state, jar, { force: attempt > 0, signal: bounded })
          const headers = { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-venice-middleface-version': '0.1.1128', 'x-venice-request-timestamp-ms': String(now()) }
          if (route.startsWith('/api/inference/')) {
            const minted = await http(state, jar, API + '/api/app/user/client_attestation/mint', { method: 'POST', headers, body: JSON.stringify({ env: {} }), signal: bounded })
            if (minted.status === 401 && !attempt) { await minted.body?.cancel(); continue }
            const attestation = await json(minted, 'client attestation')
            if (attestation.token) headers['x-venice-client-attestation'] = attestation.token
          }
          const response = await http(state, jar, API + route, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: bounded })
          if (response.status === 401 && !attempt) { await response.body?.cancel(); continue }
          return response
        }
      }, { signal: bounded })
    },
  }
}
