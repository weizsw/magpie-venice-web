import { createChrome } from './chrome.mjs'

export function createSession(options = {}) {
  const chrome = createChrome(options)
  const evaluate = expression => chrome.evaluate(expression)
  async function status() {
    return evaluate(`JSON.stringify({signedIn:!!window.Clerk?.session,sessionId:window.Clerk?.session?.id??null,uid:window.Clerk?.user?.id??null,accountId:window.Clerk?.user?.primaryEmailAddress?.emailAddress??window.Clerk?.user?.id??null})`)
  }

  // Work stays inside the authenticated Venice origin. No cookie or token leaves Chrome.
  function startJob({ id, path, body, refresh, expectedUid, timeout }) {
    const jobs = window.__magpieVeniceJobs ??= {}
    for (const [key, value] of Object.entries(jobs)) if (Date.now() - value.started > 1200000) { value.controller.abort(); delete jobs[key] }
    const controller = new AbortController()
    const busy = path.startsWith('/api/inference/chat/') && Object.values(jobs).some(j => !j.done && j.chat)
    const job = jobs[id] = { started: Date.now(), controller, queue: [], done: false, head: null, error: null, buffered: 0, chat: path.startsWith('/api/inference/chat/') }
    if (busy) {
      job.head = { status: 429, contentType: 'application/json' }
      job.queue.push(JSON.stringify({ error: { message: 'Venice Chrome session is busy; retry after the active response completes.' } }))
      job.done = true
      return JSON.stringify({ started: true })
    }
    const timer = setTimeout(() => controller.abort(), timeout)
    ;(async () => {
      try {
        const session = window.Clerk?.session
        if (!session || (expectedUid && window.Clerk?.user?.id !== expectedUid)) {
          job.head = { status: 401, contentType: 'application/json' }
          job.queue.push(JSON.stringify({ error: { message: 'Venice session expired or Chrome is signed into another account; sign in again in Magpie.' } }))
          return
        }
        const waitForAbort = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('Request cancelled', 'AbortError')), { once: true }))
        let token = await Promise.race([session.getToken({ skipCache: !!refresh }), waitForAbort])
        const headers = () => ({ 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'x-venice-request-timestamp-ms': String(Date.now()), 'x-venice-middleface-version': '0.1.1128' })
        let res
        for (let attempt = 0; attempt < 2; attempt++) {
          const h = headers()
          if (path.startsWith('/api/inference/')) {
            const mint = await fetch('https://outerface.venice.ai/api/app/user/client_attestation/mint', { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify({ env: {} }), signal: controller.signal })
            if (mint.ok) { const a = await mint.json(); if (a.token) h['x-venice-client-attestation'] = a.token }
          }
          res = await fetch('https://outerface.venice.ai' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal })
          if (res.status !== 401 || attempt) break
          await res.body?.cancel()
          token = await Promise.race([session.getToken({ skipCache: true }), waitForAbort])
        }
        job.head = { status: res.status, contentType: res.headers.get('content-type'), remaining: res.headers.get('x-ratelimit-remaining'), resets: res.headers.get('x-ratelimit-resets') }
        const reader = res.body.getReader(), decoder = new TextDecoder()
        while (true) {
          controller.signal.throwIfAborted()
          if (job.buffered > 2 * 1024 * 1024) await new Promise(r => setTimeout(r, 100))
          else {
            const { done, value } = await reader.read()
            if (done) break
            const text = decoder.decode(value, { stream: true }); job.queue.push(text); job.buffered += text.length
          }
        }
        const tail = decoder.decode(); if (tail) job.queue.push(tail)
      } catch (e) { job.error = e.name === 'AbortError' ? 'Request cancelled' : e.message }
      finally { clearTimeout(timer); job.done = true }
    })()
    return JSON.stringify({ started: true })
  }

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function request(path, body, { signal, timeout = 240000, refresh = false, expectedUid } = {}) {
    if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('://')) throw new Error('Invalid Venice path')
    signal?.throwIfAborted()
    const id = crypto.randomUUID()
    await evaluate(`(${startJob.toString()})(${JSON.stringify({ id, path, body, refresh, expectedUid, timeout })})`)
    const stop = async () => evaluate(`JSON.stringify((()=>{const j=window.__magpieVeniceJobs?.[${JSON.stringify(id)}];if(j){j.controller.abort();delete window.__magpieVeniceJobs[${JSON.stringify(id)}]}return true})())`).catch(() => {})
    const deadline = Date.now() + timeout
    let first
    const poll = () => evaluate(`JSON.stringify((()=>{const j=window.__magpieVeniceJobs?.[${JSON.stringify(id)}];if(!j)return {error:'Venice tab navigated or bridge request expired',done:true};const chunks=j.queue.splice(0,64);j.buffered-=chunks.reduce((n,s)=>n+s.length,0);return {head:j.head,chunks,done:j.done&&j.queue.length===0,error:j.error}})())`)
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error('Request cancelled')
        if (Date.now() > deadline) throw new Error('Venice request timed out')
        first = await poll()
        if (first.head || first.error) break
        await pause(150)
      }
      if (!first.head) throw new Error(first.error)
      const encoder = new TextEncoder()
      let next = first
      const abort = () => { void stop() }
      signal?.addEventListener('abort', abort, { once: true })
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            while (true) {
              if (signal?.aborted) throw signal.reason ?? new Error('Request cancelled')
              if (Date.now() > deadline) throw new Error('Venice request timed out')
              const state = next ?? await poll(); next = null
              for (const chunk of state.chunks ?? []) controller.enqueue(encoder.encode(chunk))
              if (state.done) {
                signal?.removeEventListener('abort', abort)
                await stop()
                if (state.error) controller.error(new Error(state.error)); else controller.close()
                return
              }
              if (state.chunks?.length) return
              await pause(150)
            }
          } catch (e) { signal?.removeEventListener('abort', abort); await stop(); controller.error(e) }
        },
        async cancel() { signal?.removeEventListener('abort', abort); await stop() },
      }), { status: first.head.status, headers: { 'content-type': first.head.contentType ?? 'text/plain', 'x-magpie-sign-in': first.head.status === 401 ? 'expired' : 'kept' } })
    } catch (e) { await stop(); throw e }
  }

  return { status, request, evaluate, exportCookies: () => chrome.exportCookies(), open: () => chrome.open(), disconnect: () => chrome.disconnect() }
}
