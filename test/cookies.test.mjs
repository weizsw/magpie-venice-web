import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createCookies, cookieJarFrom } from '../lib/cookies.mjs'

const uid = 'user_fixture', sid = 'sess_fixture'
const jwt = exp => ['header', Buffer.from(JSON.stringify({ sub: uid, sid, exp })).toString('base64url'), 'signature'].join('.')
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'venice-cookie-test-'))
  let renewals = 0, clock = Date.now(), rejectRenewal = false, challenge = false
  const transport = createCookies({ dataDir: root }, { now: () => clock, fetch: async (url, init) => {
    if (url.includes('clerk.venice.ai')) assert.match(init.headers.get('cookie'), /__client=fixture/)
    if (url.includes('/tokens')) {
      renewals++
      await new Promise(r => setTimeout(r, 5))
      if (rejectRenewal) return Response.json({}, { status: 401 })
      return Response.json({ jwt: jwt(Math.floor(clock / 1000) + 60) }, { headers: { 'set-cookie': '__client=fixture-rotated; Path=/; Secure; HttpOnly' } })
    }
    if (url.includes('/v1/client?')) return Response.json({ response: { sessions: [{ id: sid, status: 'active', user: { id: uid } }] } })
    if (challenge) return new Response('<html>challenge</html>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } })
    assert.ok(init.headers.get('authorization')?.startsWith('Bearer '))
    return Response.json({ agentModelOptions: [] })
  } })
  try { await fn({ root, transport, count: () => renewals, advance: ms => clock += ms, reject: () => rejectRenewal = true, challenge: () => challenge = true }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('Clerk header import needs the long-lived __client and filters other credentials', async () => {
  const jar = await cookieJarFrom('Cookie: __session=short; __client=long; unrelated=value')
  assert.equal(await jar.getCookieString('https://clerk.venice.ai/'), '__client=long')
  assert.equal(await jar.getCookieString('https://outerface.venice.ai/'), '')
})

test('cookie rotation persists; concurrent renewal reads latest state under the account lock', async () => fixture(async f => {
  const account = await f.transport.import('__client=fixture')
  const auth = { refresh: account.handle, uid }
  assert.equal(f.count(), 1)
  f.advance(61000)
  await Promise.all(Array.from({ length: 6 }, () => f.transport.refresh(auth)))
  assert.equal(f.count(), 2)
  const file = path.join(f.transport.root, account.handle + '.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.jar.cookies.find(c => c.key === '__client').value, 'fixture-rotated')
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
}))

test('expired Cloudflare export is not sent and unrelated domains are rejected', async () => {
  const jar = await cookieJarFrom([{ name: '__client', value: 'ok', domain: '.clerk.venice.ai', secure: true }, { name: 'cf_clearance', value: 'expired', domain: '.venice.ai', expires: 1 }, { name: 'other', value: 'secret', domain: '.example.com' }])
  assert.equal(await jar.getCookieString('https://outerface.venice.ai/'), '')
  assert.equal(await jar.getCookieString('https://example.com/'), '')
})

test('revoked login and active Cloudflare challenge require reimport, never launch Chrome', async () => fixture(async f => {
  const account = await f.transport.import('__client=fixture')
  const auth = { refresh: account.handle, uid }
  f.challenge()
  await assert.rejects(() => f.transport.request(auth, '/api/v2/agents/configuration_options'), e => e.challenge === true && e.signIn === 'expired')
  f.advance(61000); f.reject()
  await assert.rejects(() => f.transport.refresh(auth), e => e.signIn === 'expired')
}))

test('cookie account handles and user identity cannot select another account', async () => fixture(async f => {
  await assert.rejects(() => f.transport.refresh({ refresh: '../other' }), /missing/)
  const account = await f.transport.import('__client=fixture')
  await assert.rejects(() => f.transport.request({ refresh: account.handle, uid: 'other' }, '/api/v2/agents/configuration_options'), /does not match/)
}))

test('cookie request allows supported routes and rejects unknown routes', async () => fixture(async f => {
  const account = await f.transport.import('__client=fixture')
  const auth = { refresh: account.handle, uid }
  const resp = await f.transport.request(auth, '/api/app/models')
  assert.equal(resp.status, 200)
  await assert.rejects(() => f.transport.request(auth, '/api/unknown'), /Unsupported Venice cookie route/)
}))
