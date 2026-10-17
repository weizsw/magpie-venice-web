// Private stdin protocol: never log request headers or Cookie values.
import readline from 'node:readline'
const input = readline.createInterface({ input: process.stdin })
const line = await new Promise(resolve => input.once('line', resolve))
input.close()
const write = async value => { if (!process.stdout.write(JSON.stringify(value) + '\n')) await new Promise(resolve => process.stdout.once('drain', resolve)) }
try {
  const { url, method, headers, body } = JSON.parse(line)
  if (!['https://clerk.venice.ai', 'https://outerface.venice.ai'].includes(new URL(url).origin)) throw new Error('Invalid destination')
  const response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(900000) })
  await write({ head: { status: response.status, headers: [...response.headers].filter(([k]) => k !== 'set-cookie'), cookies: response.headers.getSetCookie() } })
  for await (const bytes of response.body ?? []) await write({ chunk: Buffer.from(bytes).toString('base64') })
  await write({ done: true })
} catch { await write({ error: 'Venice Node HTTP request failed' }); process.exitCode = 1 }
