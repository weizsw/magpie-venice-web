import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { createCookies } from '../lib/cookies.mjs'
import { MODEL, toVenice, convert } from '../lib/protocol.mjs'

try {
  const config = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'magpie')
  const auth = JSON.parse(await readFile(path.join(config, 'plugin-auth.json'), 'utf8'))['venice-web']
  if (auth?.transport !== 'cookie') throw new Error('Run magpie plugin login venice-web to import cookies first.')
  const cookies = createCookies()
  const renewed = await cookies.refresh(auth)
  console.log(JSON.stringify({ signedIn: true, transport: 'cookie', tokenValid: renewed.expires > Date.now() }))
  const command = process.argv[2] ?? 'status'
  if (command === 'test') {
    const body = { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly VENICE_OK' }] }
    const mapping = toVenice(body)
    const upstream = await cookies.request(auth, '/api/inference/chat/agents/ad-hoc', mapping.request)
    if (!upstream.ok) { await upstream.body?.cancel(); throw new Error(`Venice HTTP ${upstream.status}`) }
    const result = await (await convert(upstream, body, mapping)).json()
    console.log(JSON.stringify({ status: 'ok', answer: result.choices[0].message.content }))
  } else if (command === 'login') console.log('Cookie account is ready; to replace it run magpie plugin login venice-web')
  else if (command !== 'status') throw new Error('Usage: node scripts/session.mjs status|login|test')
} catch (e) { console.error(e.message); process.exitCode = 1 }
