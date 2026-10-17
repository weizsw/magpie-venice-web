// Explicit local validation; private browser credentials are never printed.
import { chromium } from 'playwright-core'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createCookies } from '../lib/cookies.mjs'
import { HOME_DIR } from '../lib/chrome.mjs'
import { MODEL, toVenice, convert } from '../lib/protocol.mjs'
import path from 'node:path'

const root = process.env.VENICE_COOKIE_VALIDATION_DIR
if (!root) throw new Error('Set VENICE_COOKIE_VALIDATION_DIR to a private validation directory')
await mkdir(root, { recursive: true, mode: 0o700 })
const transport = createCookies({ dataDir: root })
const authFile = path.join(root, 'auth.json')
const command = process.argv[2]
let auth
if (command === 'prepare') {
  const endpoint = JSON.parse(await readFile(path.join(HOME_DIR, 'endpoint.json'), 'utf8'))
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`)
  try {
    const context = browser.contexts()[0]
    const page = context.pages().find(p => p.url().startsWith('https://venice.ai/'))
    const userAgent = await page.evaluate(() => navigator.userAgent)
    const cookies = (await context.cookies()).filter(c => c.name === '__client')
    const imported = await transport.import(cookies, { userAgent })
    auth = { type: 'oauth', refresh: imported.handle, uid: imported.uid, transport: 'cookie' }
    await writeFile(authFile, JSON.stringify(auth), { mode: 0o600 })
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send('Browser.close')
    console.log(JSON.stringify({ test: 'only-long-lived-client-cookie', imported: true, pluginChromeClosed: true, tokenExpiresAt: new Date(imported.expires).toISOString() }))
  } finally { await browser.close().catch(() => {}) }
} else auth = JSON.parse(await readFile(authFile, 'utf8'))
const accountFile = path.join(transport.root, auth.refresh + '.json')
const previous = JSON.parse(await readFile(accountFile, 'utf8'))
if (command === 'expire-cloudflare') {
  previous.jar.cookies.push({ key: 'cf_clearance', value: 'expired-fixture', domain: 'venice.ai', path: '/', secure: true, hostOnly: false, expires: new Date(0).toISOString(), creation: new Date(0).toISOString() })
  previous.expires = 0
  await writeFile(accountFile, JSON.stringify(previous), { mode: 0o600 })
}
const renewed = await transport.refresh(auth, { force: true })
const current = JSON.parse(await readFile(accountFile, 'utf8'))
const body = { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly COOKIE_VERIFIED_OK' }], stream: false }
const mapping = toVenice(body)
const upstream = await transport.request(auth, '/api/inference/chat/agents/ad-hoc', mapping.request)
if (!upstream.ok) throw new Error(`Cookie chat HTTP ${upstream.status}`)
const result = await (await convert(upstream, body, mapping)).json()
const answer = result.choices[0].message.content
if (answer !== 'COOKIE_VERIFIED_OK') throw new Error('Unexpected cookie probe answer')
console.log(JSON.stringify({ test: command, oldTokenNaturallyExpired: previous.expires < Date.now(), newTokenIssued: previous.access !== current.access, renewalSucceeded: renewed.expires > Date.now(), chat: answer, browserUsed: false }))
