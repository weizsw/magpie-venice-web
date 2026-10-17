import test from 'node:test'
import assert from 'node:assert/strict'
import { loopbackEndpoint, createChrome } from '../lib/chrome.mjs'

test('CDP endpoints accept only explicit local browsers', () => {
  assert.equal(loopbackEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222')
  assert.equal(loopbackEndpoint('ws://127.0.0.1:9222/devtools/browser/abc'), 'ws://127.0.0.1:9222/devtools/browser/abc')
  for (const endpoint of ['https://127.0.0.1:9222', 'http://example.com:9222', 'http://127.0.0.1', 'http://name:password@127.0.0.1:9222', 'http://127.0.0.1:9222/redirect', 'ws://127.0.0.1:9222/devtools/page/abc']) {
    assert.throws(() => loopbackEndpoint(endpoint), /cdpEndpoint/)
  }
})

test('invalid external endpoint fails before launching or modifying browser state', () => {
  assert.throws(() => createChrome({ cdpEndpoint: 'https://example.com' }), /cdpEndpoint/)
})
