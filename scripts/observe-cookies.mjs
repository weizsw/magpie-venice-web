import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { createCookies } from '../lib/cookies.mjs'
import { HOME_DIR } from '../lib/chrome.mjs'

// No chat requests or credentials in the observation log. Run by a bounded OS schedule.
const root = path.join(HOME_DIR, 'observation')
const statePath = path.join(root, 'state.json')
const logPath = path.join(root, 'results.jsonl')
await mkdir(root, { recursive: true, mode: 0o700 })
const configDir = process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'magpie') : path.join(process.env.HOME ?? process.env.USERPROFILE, '.config', 'magpie')
const auths = JSON.parse(await readFile(path.join(configDir, 'plugin-auth.json'), 'utf8'))
const auth = auths['venice-web']
if (auth?.transport !== 'cookie') throw new Error('Venice Cookie login is required')
let state
try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch {}
if (process.argv.includes('--start') || !state) {
  state = { startedAt: Date.now(), endsAt: Date.now() + 72 * 3600000, checks: 0, handle: auth.refresh }
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
}
if (state.finishedAt) { console.log('Observation already finished'); process.exit(0) }
const result = { time: new Date().toISOString(), elapsedHours: +((Date.now() - state.startedAt) / 3600000).toFixed(2), browserUsed: false }
if (auth.refresh !== state.handle) result.status = 'account-changed'
else {
  try {
    const cookies = createCookies()
    const token = await cookies.refresh(auth, { force: true })
    const response = await cookies.request(auth, '/api/v2/agents/configuration_options', undefined, { timeout: 20000 })
    await response.body?.cancel()
    result.status = response.ok ? 'ok' : 'http-error'
    result.httpStatus = response.status
    result.tokenValid = token.expires > Date.now()
  } catch (e) { result.status = e.challenge ? 'browser-verification-required' : e.signIn === 'expired' ? 'login-expired' : 'network-or-transport-error' }
}
state.checks++
if (Date.now() >= state.endsAt || result.status === 'account-changed') state.finishedAt = Date.now()
await appendFile(logPath, JSON.stringify(result) + '\n', { mode: 0o600 })
await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
console.log(JSON.stringify({ ...result, finished: !!state.finishedAt, checks: state.checks }))
