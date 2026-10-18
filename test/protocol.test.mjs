import test from 'node:test'
import assert from 'node:assert/strict'
import { MODEL, MODEL_NAME, QWEN_MODEL, QWEN_MODEL_NAME, resolveModel, MODEL_ALIASES, events, toVenice, convert, parseToolReply, countTokens, estimatePromptTokens, reasoningMode, REASONING_VARIANTS } from '../lib/protocol.mjs'
import { VeniceWebPlugin } from '../index.mjs'

const encoder = new TextEncoder()
const frame = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
function upstream(text, width = 1) {
  const bytes = encoder.encode(text)
  let i = 0
  return new Response(new ReadableStream({ pull(c) { if (i >= bytes.length) c.close(); else { c.enqueue(bytes.slice(i, i + width)); i += width } } }))
}
const body = { model: MODEL, messages: [{ role: 'user', content: 'hello' }] }
const tool = { type: 'function', function: { name: 'edit_file', parameters: { type: 'object' } } }

test('SSE survives split UTF-8, CRLF, multiline data and keepalive', async () => {
  const input = ': keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":\r\ndata: "你好🌊"}\r\n\r\ndata: [DONE]\r\n\r\n'
  const result = []
  for await (const ev of events(upstream(input).body)) result.push(ev)
  assert.deepEqual(result, [{ type: 'response.output_text.delta', delta: '你好🌊' }])
})

test('plain stream converts content and rejects truncated success', async () => {
  const data = frame('response.output_text.delta', { delta: 'hello' }) + frame('response.completed', { response: { status: 'completed' } })
  const response = await convert(upstream(data), { ...body, stream: true }, toVenice(body))
  const text = await response.text()
  assert.match(text, /"content":"hello"/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.match(text, /data: \[DONE\]/)
  await assert.rejects(() => convert(upstream(frame('response.output_text.delta', { delta: 'partial' })), body, toVenice(body)), /before response.completed/)
})

test('provider error is propagated instead of a successful final chunk', async () => {
  await assert.rejects(() => convert(upstream(frame('response.failed', { response: { error: { message: 'limit reached' } } })), body, toVenice(body)), /limit reached/)
})

test('tool roundtrip preserves quotes, backslashes, complete history and call identity', async () => {
  const args = { path: 'src/a.mjs', text: 'const x = "a\\b"\n<hello>' }
  const envelope = JSON.stringify({ content: '', tool_calls: [{ name: 'edit_file', arguments: args }] })
  const mapping = toVenice({ ...body, tools: [tool], tool_choice: 'required' })
  const data = frame('response.output_text.delta', { delta: envelope }) + frame('response.completed', {})
  const response = await convert(upstream(data, 7), body, mapping)
  const answer = (await response.json()).choices[0]
  assert.equal(answer.finish_reason, 'tool_calls')
  assert.deepEqual(JSON.parse(answer.message.tool_calls[0].function.arguments), args)
  const next = toVenice({ ...body, tools: [tool], messages: [...body.messages, answer.message, { role: 'tool', tool_call_id: answer.message.tool_calls[0].id, content: 'saved' }] })
  assert.equal(JSON.parse(next.request.messages[1].content[0].text).tool_calls[0].id, answer.message.tool_calls[0].id)
  assert.deepEqual(JSON.parse(next.request.messages[1].content[0].text).tool_calls[0].arguments, args)
  assert.equal(JSON.parse(next.request.messages[2].content[0].text).magpie_tool_result.content, 'saved')
})

test('tool parser rejects undeclared calls and invalid required choices', () => {
  assert.throws(() => parseToolReply('{"content":"","tool_calls":[{"name":"shell","arguments":{}}]}', new Set(['edit_file'])), /unavailable/)
  assert.throws(() => parseToolReply('{"content":"done","tool_calls":[]}', new Set(['edit_file']), 'required'), /required/)
  assert.throws(() => parseToolReply('not json', new Set()), /valid tool JSON/)
})

test('unsupported images and structured output fail explicitly; system instructions stay separate', () => {
  assert.throws(() => toVenice({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }), /text only/)
  assert.throws(() => toVenice({ ...body, response_format: { type: 'json_schema' } }), /response_format/)
  assert.throws(() => toVenice({ ...body, tools: [tool] }, { toolMode: 'off' }), /disabled/)
  const mapping = toVenice({ ...body, messages: [{ role: 'system', content: 'system text' }, ...body.messages], tools: [tool], tool_choice: 'none' })
  assert.equal(mapping.request.systemPrompt.instructions, 'system text')
  assert.equal(mapping.emulatedTools, false)
  assert.equal(mapping.request.messages.length, 1)
})

test('cancelling converted stream cancels the underlying reader', async () => {
  let cancelled = false
  const source = new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(frame('response.output_text.delta', { delta: 'hi' }))) }, cancel() { cancelled = true } }))
  const response = await convert(source, { ...body, stream: true }, toVenice(body))
  const reader = response.body.getReader()
  await reader.read(); await reader.read(); await reader.cancel()
  assert.equal(cancelled, true)
})

test('reasoning_effort maps onto the real Venice web modes and effort levels', () => {
  assert.ok(REASONING_VARIANTS.high)
  assert.ok(REASONING_VARIANTS.max)
  assert.ok(REASONING_VARIANTS.medium)
  assert.ok(REASONING_VARIANTS.low)
  assert.ok(REASONING_VARIANTS.none)
  assert.equal(reasoningMode({}), 'disabled')
  assert.equal(reasoningMode({ reasoning_effort: 'none' }), 'disabled')
  assert.equal(reasoningMode({ reasoning_effort: 'minimal' }), 'disabled')
  assert.equal(reasoningMode({ reasoning_effort: 'disabled' }), 'disabled')
  assert.equal(reasoningMode({ reasoning_effort: 'adaptive' }), 'adaptive')
  assert.equal(reasoningMode({ reasoning_effort: 'auto' }), 'adaptive')
  assert.equal(reasoningMode({ reasoning_effort: 'medium' }), 'enabled')
  assert.equal(reasoningMode({ reasoning_effort: 'high' }), 'enabled')
  assert.equal(reasoningMode({ reasoning_effort: 'enabled' }), 'enabled')
  assert.equal(toVenice({ ...body, reasoning_effort: 'adaptive' }).request.reasoningMode, 'adaptive')
  assert.equal(toVenice({ ...body, reasoning_effort: 'medium' }).request.reasoningEffort, 'medium')
  assert.equal(toVenice({ ...body, reasoning_effort: 'low' }).request.reasoningEffort, 'low')
  assert.equal(toVenice({ ...body, reasoning_effort: 'high' }).request.reasoningEffort, 'high')
  assert.equal(toVenice({ ...body, model: 'qwen-3-8-27b', reasoning_effort: 'high' }).request.reasoningEffort, 'xhigh')
  assert.equal(toVenice({ ...body, reasoning_effort: 'max' }).request.reasoningEffort, 'max')
})

test('reasoning items are separated from the answer, in stream and non-stream', async () => {
  // Venice labels reasoning deltas as output_text.delta; only the item type tells them apart.
  const sse = frame('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'rs_1' } })
    + frame('response.output_text.delta', { output_index: 0, delta: 'let me think' })
    + frame('response.output_item.added', { output_index: 1, item: { type: 'message', id: 'msg_1' } })
    + frame('response.output_text.delta', { output_index: 1, delta: 'the answer' })
    + frame('response.completed', {})

  const json = await (await convert(upstream(sse), { ...body, reasoning_effort: 'enabled' }, toVenice({ ...body, reasoning_effort: 'enabled' }))).json()
  const message = json.choices[0].message
  assert.equal(message.content, 'the answer')
  assert.equal(message.reasoning_content, 'let me think')
  assert.equal(json.usage.completion_tokens_details.reasoning_tokens, 4)
  assert.equal(json.usage.total_tokens, json.usage.prompt_tokens + json.usage.completion_tokens)

  const streamed = await (await convert(upstream(sse), { ...body, stream: true }, toVenice(body))).text()
  const deltas = streamed.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).map(c => c.choices[0]?.delta ?? {})
  assert.deepEqual(deltas.filter(d => d.content).map(d => d.content), ['the answer'])
  assert.deepEqual(deltas.filter(d => d.reasoning_content).map(d => d.reasoning_content), ['let me think'])
})

test('plugin exposes only its provider with a single browser login method', async () => {
  const plugin = await VeniceWebPlugin({})
  const cfg = {}; await plugin.config(cfg)
  assert.equal(plugin.auth.provider, 'venice-web')
  assert.equal(plugin.auth.maxConcurrency, 1)
  assert.ok(Object.keys(cfg.provider['venice-web'].models).length >= 20)
  assert.equal(cfg.provider['venice-web'].models[MODEL].limit.context, 524288)
  assert.equal(cfg.provider['venice-web'].models[MODEL].limit.output, 32768)
  assert.equal(cfg.provider['venice-web'].models[QWEN_MODEL].limit.context, 262144)
  assert.equal(cfg.provider['venice-web'].models[QWEN_MODEL].limit.output, 65536)
  assert.equal(plugin.auth.methods[0].type, 'oauth')
  assert.ok(cfg.provider['venice-web'].models[MODEL].variants.high)
  assert.ok(cfg.provider['venice-web'].models[MODEL].variants.max)
  assert.ok(cfg.provider['venice-web'].models[MODEL].variants.medium)
  assert.ok(cfg.provider['venice-web'].models[MODEL].variants.low)
  assert.ok(cfg.provider['venice-web'].models[MODEL].variants.none)
  assert.ok(cfg.provider['venice-web'].models[QWEN_MODEL].variants.high)
  assert.ok(cfg.provider['venice-web'].models[QWEN_MODEL].variants.max)
  assert.throws(() => toVenice({ ...body, model: 'deepseek-v4-1-flash' }), /Unsupported model/)
})

test('qwen-3-8-27b and aliases map correctly and convert preserves requested model', async () => {
  assert.equal(resolveModel('qwen-3-8-27b'), 'qwen-3-8-27b')
  assert.equal(resolveModel('qwen-3.8-27b'), 'qwen-3-8-27b')
  assert.equal(resolveModel('qwen3.8-27b'), 'qwen-3-8-27b')
  assert.equal(resolveModel('qwen3-8-27b'), 'qwen-3-8-27b')
  assert.equal(resolveModel('qwen38-27b'), 'qwen-3-8-27b')
  assert.equal(resolveModel('deepseek-v4-1-flash-free'), 'deepseek-v4-1-flash-free')
  assert.equal(resolveModel('unknown-model'), undefined)

  const req = toVenice({ model: 'qwen-3.8-27b', messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(req.request.modelId, 'qwen-3-8-27b')

  const sse = frame('response.output_text.delta', { delta: 'qwen answer' }) + frame('response.completed', {})
  const resp = await convert(upstream(sse), { model: 'qwen-3-8-27b', messages: [{ role: 'user', content: 'hello' }] }, req)
  const json = await resp.json()
  assert.equal(json.model, 'qwen-3-8-27b')
  assert.equal(json.choices[0].message.content, 'qwen answer')
})

test('CJK and English token estimation', () => {
  assert.equal(countTokens('hello world'), 4)
  assert.equal(countTokens('测试翻译内容。'), 7)
})

test('usage accurately calculates prompt and completion tokens for CJK, English and reasoning in stream and non-stream', async () => {
  const reqBody = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a translation assistant.' },
      { role: 'user', content: 'Translate this text: 苹果' },
    ],
  }
  const promptTokens = estimatePromptTokens(reqBody)
  assert.ok(promptTokens > 15)

  const sseData = frame('response.reasoning_text.delta', { delta: 'Thinking about apple...' })
    + frame('response.output_text.delta', { delta: 'Apple' })
    + frame('response.completed', {})

  const nonStream = await convert(upstream(sseData), reqBody, toVenice(reqBody))
  const json = await nonStream.json()
  assert.equal(json.usage.prompt_tokens, promptTokens)
  assert.ok(json.usage.completion_tokens >= 5)
  assert.equal(json.usage.total_tokens, json.usage.prompt_tokens + json.usage.completion_tokens)
  assert.ok(json.usage.completion_tokens_details.reasoning_tokens >= 4)

  const stream = await convert(upstream(sseData), { ...reqBody, stream: true }, toVenice(reqBody))
  const text = await stream.text()
  assert.match(text, /"finish_reason":"stop"/)
  assert.match(text, /"choices":\[\],"usage":{"prompt_tokens":/)
  assert.match(text, /"reasoning_tokens":/)
})

