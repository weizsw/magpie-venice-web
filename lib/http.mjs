import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

// Node's HTTP/TLS transport is used under Bun as well; no credentials in argv or shell.
export async function cookieFetch(url, init = {}, { nodePath = 'node' } = {}) {
  if (typeof Bun === 'undefined') return fetch(url, init)
  init.signal?.throwIfAborted()
  const child = spawn(nodePath, [fileURLToPath(new URL('./node-http.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const reader = Readable.toWeb(child.stdout).getReader()
  child.stderr.resume()
  let buffer = '', ended = false, failure
  const abort = () => child.kill()
  init.signal?.addEventListener('abort', abort, { once: true })
  child.on('error', () => { failure = new Error('Node.js is required for Cookie mode under Magpie. Install Node.js 22+ or set nodePath.'); void reader.cancel().catch(() => {}) })
  child.on('close', code => { if (code) failure ??= new Error('Venice Node HTTP transport failed') })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify({ url, method: init.method, headers: [...new Headers(init.headers)], body: init.body }) + '\n')
  const decoder = new TextDecoder()
  async function next() {
    while (!buffer.includes('\n')) {
      const { done, value } = await reader.read()
      if (done) { ended = true; throw failure ?? new Error('Venice HTTP transport ended early') }
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 16 * 1024 * 1024) throw new Error('Venice transport frame exceeded limit')
    }
    const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
    const result = JSON.parse(line)
    if (result.error) throw new Error(result.error)
    return result
  }
  const cleanup = () => { init.signal?.removeEventListener('abort', abort); child.kill() }
  try {
    const first = await next()
    if (!first.head) throw new Error('Venice transport returned no response head')
    const headers = new Headers(first.head.headers)
    headers.delete('content-encoding'); headers.delete('content-length')
    for (const cookie of first.head.cookies) headers.append('set-cookie', cookie)
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          init.signal?.throwIfAborted()
          const event = await next()
          if (event.done) { ended = true; controller.close(); cleanup() }
          else if (event.chunk) controller.enqueue(new Uint8Array(Buffer.from(event.chunk, 'base64')))
          else throw new Error('Invalid Venice transport event')
        } catch (e) { controller.error(e); cleanup() }
      },
      async cancel() { ended = true; await reader.cancel().catch(() => {}); cleanup() },
    }), { status: first.head.status, headers })
  } catch (e) { if (!ended) cleanup(); throw e }
}
