import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createChrome } from '../lib/chrome.mjs'

const executablePath = process.env.VENICE_WEB_CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)

test('three concurrent provider checks create only one Venice tab', { skip: typeof Bun !== 'undefined' ? 'Playwright browser launch integration runs under Node; Bun host CDP is verified separately' : false, timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'venice-tabs-'))
  let context
  const clients = Array.from({ length: 3 }, () => createChrome({ dataDir: root }))
  try {
    try {
      context = await chromium.launchPersistentContext(path.join(root, 'chrome-profile'), { executablePath, headless: true, args: ['--remote-debugging-port=0'] })
    } catch (e) {
      if (e.message.includes("Executable doesn't exist")) return
      throw e
    }
    const [port, socketPath] = (await readFile(path.join(root, 'chrome-profile', 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
    await writeFile(path.join(root, 'endpoint.json'), JSON.stringify({ port: Number(port), socketPath }))
    await context.route('https://venice.ai/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 100))
      await route.fulfill({ contentType: 'text/html', body: '<script>window.Clerk={loaded:true}</script>' })
    })
    await Promise.all(clients.map(client => client.evaluate('JSON.stringify(true)')))
    assert.equal(context.pages().filter(p => p.url().startsWith('https://venice.ai/')).length, 1)
  } finally {
    await Promise.all(clients.map(client => client.disconnect()))
    await context?.close()
    await rm(root, { recursive: true, force: true })
  }
})
