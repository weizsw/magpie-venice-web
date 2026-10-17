import { createSession } from './lib/session.mjs'
import { createCookies } from './lib/cookies.mjs'
import { MODEL, MODEL_NAME, DEFAULT_FREE_MODELS, KNOWN_ALIASES, DISCOVERED_FREE_MODELS, REASONING_VARIANTS, toVenice, convert } from './lib/protocol.mjs'

const PROVIDER = 'venice-web'
const BASE = 'https://venice.ai/magpie/v1'
const expired = message => Object.assign(new Error(message), { signIn: 'expired' })
const fail = (message, status = 400) => Response.json({ error: { message, type: 'venice_web_error' } }, { status })

const buildModels = (toolMode, catalogModels = DEFAULT_FREE_MODELS) => {
  const result = {}
  for (const [id, m] of Object.entries(catalogModels)) {
    result[id] = {
      name: m.name,
      limit: m.limit ?? { context: 128000, output: 16384 },
      reasoning: m.reasoning ?? true,
      tool_call: toolMode === 'prompt',
      modalities: { input: ['text'], output: ['text'] },
      free: true,
      ...(m.reasoning ? { variants: REASONING_VARIANTS } : {}),
    }
  }
  return result
}

export const VeniceWebPlugin = async (_input, options = {}) => {
  const cookies = createCookies(options)
  const browserSession = createSession(options)
  const toolMode = options.toolMode ?? 'prompt'
  if (!['prompt', 'off'].includes(toolMode)) throw new Error('toolMode must be prompt or off')
  const timeout = options.timeoutMs ?? 240000
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 900000) throw new Error('timeoutMs must be between 1000 and 900000')
  const signedIn = imported => ({ type: 'success', access: 'cookie-managed', refresh: imported.handle, expires: imported.expires, accountId: imported.accountId, uid: imported.uid, transport: 'cookie' })
  async function cookieAuth(auth) {
    if (auth?.transport !== 'cookie') throw expired('Venice now uses cookie connections. Sign in again to import the Chrome session or private-window cookies.')
    return auth
  }
  async function renew(auth) { return cookies.refresh(await cookieAuth(auth)) }
  async function request(auth, route, body, requestOptions = {}) {
    return cookies.request(await cookieAuth(auth), route, body, { timeout, ...requestOptions })
  }
  return {
    config: async cfg => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'Venice Web', npm: '@ai-sdk/openai-compatible', api: BASE,
        models: buildModels(toolMode),
      }
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      refreshLead: 15000,
      methods: [{
        type: 'oauth', label: 'Import private-window Cookie (no browser needed afterwards)',
        prompts: [{ type: 'text', key: 'userAgent', message: 'User-Agent from the same private browser request (Network → Request Headers)', placeholder: 'Mozilla/5.0 ...', validate: value => value?.trim() ? undefined : 'Paste the browser User-Agent; a generic value can trigger Cloudflare.' }],
        async authorize(inputs) {
          return {
            url: 'https://venice.ai/chat/agent',
            instructions: 'Sign into Venice in a private/incognito window. Export Venice + clerk.venice.ai cookies as JSON, or copy the Cookie request header from a clerk.venice.ai request containing __client. Paste here, then close the private window without signing out. Cookies stay in a private local account file; Magpie saves only its handle.',
            method: 'code',
            async callback(code) {
              try { return signedIn(await cookies.import(code, { userAgent: inputs?.userAgent ?? options.userAgent })) }
              catch (e) { return { type: 'failed', error: e.message } }
            },
          }
        },
      }, {
        type: 'oauth', label: 'Sign in with Chrome and import cookies automatically',
        async authorize() {
          await browserSession.open()
          return {
            url: '', method: 'auto',
            instructions: 'Sign into Venice in the plugin Chrome window. After import succeeds you can close that window; requests and renewal run without Chrome.',
            async callback() {
              try {
                const deadline = Date.now() + 300000
                while (Date.now() < deadline) {
                  const current = await browserSession.status()
                  if (current.signedIn) {
                    const exported = await browserSession.exportCookies()
                    return signedIn(await cookies.import(exported.cookies, { userAgent: exported.userAgent, expectedUid: current.uid }))
                  }
                  await new Promise(resolve => setTimeout(resolve, 1000))
                }
                return { type: 'failed', error: 'Sign into Venice in Chrome, then retry.' }
              } catch (e) { return { type: 'failed', error: e.message } }
              finally { await browserSession.disconnect() }
            },
          }
        },
      }],
      refresh: renew,
      async loader(getAuth) {
        return {
          baseURL: BASE,
          apiKey: 'cookie-managed',
          async fetch(input, init = {}) {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
            if (url.origin !== 'https://venice.ai' || url.pathname !== '/magpie/v1/chat/completions') return fail('Unsupported Venice Web endpoint', 404)
            let body, mapping
            try {
              const raw = init.body ?? (input instanceof Request ? await input.text() : '')
              body = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
              mapping = toVenice(body, { toolMode })
            } catch (e) { return fail(e.message) }
            const auth = await getAuth()
            if (auth?.type !== 'oauth' || !auth.uid) throw expired('Sign into Venice Web in Magpie first.')
            const upstream = await request(auth, '/api/inference/chat/agents/ad-hoc', mapping.request, { signal: init.signal ?? input?.signal })
            if (!upstream.ok) {
              // Preserve failure status for Magpie failover, but expose a bounded API-shaped error.
              const text = await upstream.text()
              let message = `Venice web returned HTTP ${upstream.status}`
              try { const data = JSON.parse(text); message = typeof data.error === 'string' ? data.error : data.error?.message ?? message } catch {}
              const result = fail(message, upstream.status)
              result.headers.set('X-Magpie-Sign-In', upstream.status === 401 ? 'expired' : 'kept')
              return result
            }
            return convert(upstream, body, mapping)
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        await renew(auth)
        return { plan: 'Venice Web · Cookie connection', account: auth.accountId, windows: [], signIn: 'kept' }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        let agentsData, appData
        try {
          const agentsRes = await request(auth, '/api/v2/agents/configuration_options').catch(() => null)
          if (agentsRes?.status === 401) throw expired('Venice session expired')
          if (agentsRes?.ok) agentsData = await agentsRes.json().catch(() => null)

          const appRes = await request(auth, '/api/app/models').catch(() => null)
          if (appRes?.status === 401) throw expired('Venice session expired')
          if (appRes?.ok) appData = await appRes.json().catch(() => null)
        } catch (e) {
          if (e.signIn === 'expired') throw e
          return provider.models
        }

        if (!agentsData && !appData) return provider.models

        const discovered = {}

        if (agentsData?.agentModelOptions) {
          for (const m of agentsData.agentModelOptions) {
            if (m.usesCredits === false && m.id !== 'default') {
              discovered[m.id] = {
                name: m.name,
                limit: { context: 524288, output: 32768 },
                reasoning: true,
                free: true,
              }
            }
          }
        }

        if (appData?.text?.models) {
          for (const m of appData.text.models) {
            if (m.usesCredits === false && m.active !== false) {
              let name = m.friendly_name || m.name || m.id
              if (m.id.startsWith('e2ee-') && !name.includes('TEE') && !name.includes('E2EE')) {
                name = `${name} (TEE)`
              }
              discovered[m.id] = {
                name,
                limit: {
                  context: m.maxContextLength || 128000,
                  output: m.maxResponseTokens || 16384,
                },
                reasoning: m.supportsReasoning ?? false,
                free: true,
              }
              if (m.aliasIds) {
                for (const a of m.aliasIds) KNOWN_ALIASES[a] = m.id
              }
            }
          }
        }

        if (!Object.keys(discovered).length) return provider.models

        for (const [id, m] of Object.entries(discovered)) {
          DISCOVERED_FREE_MODELS.set(id, m)
        }

        return buildModels(toolMode, discovered)
      },
    },
  }
}
