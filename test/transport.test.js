/**
 * 传输层的离线测试：URL 组装、基址校验、重试语义、超时与取消、并发限流、错误文案。
 *
 * 为什么值得单独测：这一层决定了"写操作会不会被偷偷重试"（绝不允许）与
 * "取消能不能立刻中断在途请求"，两者都属于错了不会报错、只会造成真实伤害的类型。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  Transport, buildUrl, createLimiters, extractErrorMessage, isIdempotent, looksLikeHtml, looksLikeJson, normalizeBase,
} from '../src/transport/client.js'
import { respond } from './helpers.js'

/* ───────────────── URL 与基址 ───────────────── */

test('normalizeBase：去尾斜杠、只允许 http(s)、禁止内嵌凭据', () => {
  assert.equal(normalizeBase('https://zt.example.com/'), 'https://zt.example.com')
  assert.equal(normalizeBase('https://zt.example.com/zentao/'), 'https://zt.example.com/zentao')
  assert.throws(() => normalizeBase(''), /未配置/)
  assert.throws(() => normalizeBase('ftp://zt.example.com'), /只允许 http\/https/)
  assert.throws(() => normalizeBase('https://user:pw@zt.example.com'), /不允许内嵌用户名密码/)
  assert.throws(() => normalizeBase('not a url'), /不是合法 URL/)
})

test('buildUrl：跳过 undefined/空值，path 缺前导斜杠也能拼', () => {
  assert.equal(
    buildUrl('https://zt.example.com/zentao', '/api.php/v1/products', { page: 1, limit: 50, skip: undefined, empty: '' }),
    'https://zt.example.com/zentao/api.php/v1/products?page=1&limit=50',
  )
  assert.equal(buildUrl('https://zt.example.com', 'products'), 'https://zt.example.com/products')
  assert.equal(buildUrl('https://zt.example.com', '/products'), 'https://zt.example.com/products')
})

test('只有 GET/HEAD/OPTIONS 是幂等的（写操作永不被自动重试）', () => {
  assert.equal(isIdempotent('GET'), true)
  assert.equal(isIdempotent('head'), true)
  assert.equal(isIdempotent('POST'), false)
  assert.equal(isIdempotent('PUT'), false)
  assert.equal(isIdempotent('DELETE'), false)
})

/* ───────────────── 重试语义 ───────────────── */

function sequenceFetch (responses, { onCall } = {}) {
  let index = 0
  const fetchImpl = async (url, init) => {
    if (onCall) onCall(url, init, index)
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (typeof next === 'function') return next(url, init)
    return next
  }
  Object.defineProperty(fetchImpl, 'calls', { get: () => index })
  return fetchImpl
}

test('GET 遇到 503 会重试，次数受 maxRetries 约束', async () => {
  const fetchImpl = sequenceFetch([respond(503, { error: 'busy' }), respond(503, {}), respond(200, { ok: true })])
  const transport = new Transport({ fetchImpl, getTimeoutMs: () => 1000, getMaxRetries: () => 2 })
  const result = await transport.request({ base: 'https://zt.example.com', path: '/products' })
  assert.equal(result.status, 200)
  assert.equal(fetchImpl.calls, 3, '1 次原始 + 2 次重试')
  assert.equal(transport.stats.retries, 2)
})

test('**写操作绝不重试**：POST 遇到 503 只发一次', async () => {
  const fetchImpl = sequenceFetch([respond(503, { error: 'busy' })])
  const transport = new Transport({ fetchImpl, getTimeoutMs: () => 1000, getMaxRetries: () => 3 })
  const result = await transport.request({ base: 'https://zt.example.com', path: '/tasks', method: 'POST', body: {} })
  assert.equal(result.status, 503)
  assert.equal(fetchImpl.calls, 1, '写操作重试会造成重复落库')
})

test('404 等不可重试状态码不做无谓重试', async () => {
  const fetchImpl = sequenceFetch([respond(404, { error: 'nope' })])
  const transport = new Transport({ fetchImpl, getTimeoutMs: () => 1000, getMaxRetries: () => 3 })
  const result = await transport.request({ base: 'https://zt.example.com', path: '/products/1' })
  assert.equal(result.status, 404)
  assert.equal(fetchImpl.calls, 1)
})

test('网络错误在幂等请求上重试，最终仍失败则抛 NETWORK', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; throw new Error('boom') }
  const transport = new Transport({ fetchImpl, getTimeoutMs: () => 1000, getMaxRetries: () => 2 })
  await assert.rejects(
    transport.request({ base: 'https://zt.example.com', path: '/products' }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      assert.match(error.message, /无法连接禅道/)
      return true
    },
  )
  assert.equal(calls, 3)
})

test('Retry-After 头会被尊重（毫秒级验证：不应立刻重试）', async () => {
  const started = Date.now()
  const fetchImpl = sequenceFetch([
    () => {
      const response = respond(429, { error: 'slow down' })
      response.headers.get = (name) => (String(name).toLowerCase() === 'retry-after' ? '0.05' : 'application/json')
      return response
    },
    respond(200, { ok: true }),
  ])
  const transport = new Transport({ fetchImpl, getTimeoutMs: () => 2000, getMaxRetries: () => 1 })
  const result = await transport.request({ base: 'https://zt.example.com', path: '/products' })
  assert.equal(result.status, 200)
  assert.ok(Date.now() - started >= 40, 'Retry-After 至少被等了一会儿')
})

/* ───────────────── 超时与取消 ───────────────── */

/** 会在收到中止信号时拒绝的 fetch；**已中止的信号要立刻拒绝**（真实 fetch 的行为）。 */
function abortableFetch (errorName = 'TimeoutError') {
  return (url, init) => new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted')
      error.name = errorName
      reject(error)
    }
    if (init.signal?.aborted) { fail(); return }
    init.signal?.addEventListener('abort', fail)
  })
}

test('超时抛 TIMEOUT，且带上方法/URL（URL 已脱敏）', async () => {
  const transport = new Transport({ fetchImpl: abortableFetch(), getTimeoutMs: () => 20, getMaxRetries: () => 0 })
  await assert.rejects(
    transport.request({ base: 'https://zt.example.com', path: '/products', query: { token: 'zzz' } }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.doesNotMatch(JSON.stringify(error.facts), /zzz/, 'facts 里的 URL 必须脱敏')
      return true
    },
  )
})

test('调用方取消 → 立刻结束，并明确说是被取消（不冒充超时）', async () => {
  const controller = new AbortController()
  const transport = new Transport({ fetchImpl: abortableFetch('AbortError'), getTimeoutMs: () => 5000, getMaxRetries: () => 2 })
  const pending = transport.request({ base: 'https://zt.example.com', path: '/products', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.match(error.message, /取消/)
    return true
  })
})

test('信号在请求发出前就已中止 → 也必须立刻结束（不能挂住）', async () => {
  const controller = new AbortController()
  controller.abort()
  const transport = new Transport({ fetchImpl: abortableFetch('AbortError'), getTimeoutMs: () => 5000, getMaxRetries: () => 0 })
  await assert.rejects(
    transport.request({ base: 'https://zt.example.com', path: '/products', signal: controller.signal }),
    /取消/,
  )
})

test('疑似 TLS 失败时，hint 指向 NODE_EXTRA_CA_CERTS（而不是教用户关校验）', async () => {
  const fetchImpl = async () => {
    const error = new Error('unable to verify the first certificate')
    error.cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
    throw error
  }
  const transport = new Transport({ fetchImpl, getTimeoutMs: () => 1000, getMaxRetries: () => 0 })
  await assert.rejects(
    transport.request({ base: 'https://zt.example.com', path: '/products' }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      assert.match(error.hint, /NODE_EXTRA_CA_CERTS/)
      assert.match(error.hint, /不会关闭证书校验/)
      return true
    },
  )
})

/* ───────────────── 并发限流 ───────────────── */

test('并发限流：读 2 / 写 1', async () => {
  let active = 0
  let maxActive = 0
  const fetchImpl = async (url, init) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return respond(200, { ok: true })
  }
  const transport = new Transport({
    fetchImpl,
    getTimeoutMs: () => 5000,
    getMaxRetries: () => 0,
    limiters: createLimiters({ reads: 2, writes: 1 }),
  })

  maxActive = 0
  await Promise.all([1, 2, 3, 4].map(() => transport.request({ base: 'https://zt.example.com', path: '/products' })))
  assert.equal(maxActive, 2, '读并发上限为 2')

  active = 0
  maxActive = 0
  await Promise.all([1, 2, 3].map((n) => transport.request({
    base: 'https://zt.example.com', path: `/tasks/${n}`, method: 'PUT', body: { pri: n },
  })))
  assert.equal(maxActive, 1, '写并发上限为 1（单站点串行）')
})

/* ───────────────── 响应解析与错误文案 ───────────────── */

test('响应解析：JSON 正常解析；非 JSON 内容不炸并保留原文', async () => {
  const transport = new Transport({
    fetchImpl: sequenceFetch([respond(200, { total: 1, products: [] }), { status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>x</html>' }]),
    getTimeoutMs: () => 1000,
    getMaxRetries: () => 0,
  })
  const json = await transport.request({ base: 'https://zt.example.com', path: '/products' })
  assert.deepEqual(json.json, { total: 1, products: [] })
  const html = await transport.request({ base: 'https://zt.example.com', path: '/x' })
  assert.equal(html.json, undefined)
  assert.equal(looksLikeHtml(html), true)
})

test('extractErrorMessage：只取白名单字段，HTML 会被识别为"打到了网页"，超长被截断', () => {
  assert.equal(extractErrorMessage({ error: '字段不合法' }), '字段不合法')
  assert.equal(extractErrorMessage({ message: 'msg' }), 'msg')
  assert.equal(extractErrorMessage({ errors: { msg: 'nested' } }), 'nested')
  assert.equal(extractErrorMessage(undefined, '<!DOCTYPE html><html>'), null || extractErrorMessage(undefined, '<!DOCTYPE html><html>'))
  assert.match(extractErrorMessage(undefined, '<html>login</html>'), /登录页|HTML/)
  assert.match(extractErrorMessage({ error: 'x'.repeat(900) }), /（已截断）$/)
  assert.equal(extractErrorMessage({}, ''), '')
})

test('extractErrorMessage：**逐字段错误信封**必须能读出消息（真实禅道形状，实测校准）', () => {
  // 实测：POST /stories 缺少必填字段时返回这个形状
  assert.equal(
    extractErrorMessage({ error: { reviewer: ['『评审人』不能为空。'] } }),
    '『评审人』不能为空。',
  )
  // 实测：POST /projects 的形状
  assert.equal(
    extractErrorMessage({ error: { workflowGroup: ['「项目流程」不能为空。'] } }),
    '「项目流程」不能为空。',
  )
  // 多层嵌套也要能挖到（深度上限 3）
  assert.equal(extractErrorMessage({ error: { a: { b: ['深层消息'] } } }), '深层消息')
  // 认不出来就返回空，而不是编一个
  assert.equal(extractErrorMessage({ error: {} }, ''), '')
  assert.equal(extractErrorMessage({ nested: { nothing: 1 } }, ''), '')
})

/* ─────────── looksLikeHtml：**响应体形状优先于 Content-Type** ─────────── */

test('looksLikeHtml：真实禅道的 JSON 体 + text/html 头**不能**被判成网页（实测校准）', () => {
  // GET /zentao/api.php/v1 的真实响应：200 + 合法 JSON + Content-Type: text/html; Language=UTF-8
  const real = {
    status: 200,
    ok: true,
    contentType: 'text/html; Language=UTF-8;charset=UTF-8',
    json: { error: 'EMPTY_ENTRY' },
    text: '{"error":"EMPTY_ENTRY"}',
  }
  assert.equal(looksLikeJson(real), true)
  assert.equal(looksLikeHtml(real), false, '合法的 JSON 错误体不能被误判成"打到了网页"')
})

test('looksLikeHtml：非 JSON + html 头 → 是网页（登录页接管的情形）', () => {
  assert.equal(looksLikeHtml({ status: 200, contentType: 'text/html', json: undefined, text: '<!DOCTYPE html><html>login</html>' }), true)
  assert.equal(looksLikeHtml({ status: 200, contentType: 'text/html', json: undefined, text: 'Short answer from proxy' }), true, 'Content-Type 说 html 就按网页处理')
})

test('looksLikeHtml：JSON 体但内容真是 HTML 标签 → 仍是网页', () => {
  assert.equal(looksLikeHtml({ status: 200, contentType: 'application/json', json: {}, text: '<html>oops</html>' }), true)
})

test('looksLikeHtml：普通 JSON + application/json → 不是网页', () => {
  assert.equal(looksLikeHtml({ status: 200, contentType: 'application/json', json: { page: 1, tasks: [] }, text: '{"page":1,"tasks":[]}' }), false)
})

test('Transport.toError 保留 HTTP 状态与脱敏后的 URL', () => {
  const error = Transport.toError({
    status: 422,
    json: { error: '标题不能为空' },
    url: 'https://zt.example.com/tasks?token=***',
    contentType: 'application/json',
  }, { messagePrefix: '新建任务' })
  assert.equal(error.code, 'VALIDATION')
  assert.match(error.message, /新建任务（HTTP 422）/)
  assert.match(error.message, /标题不能为空/)
  assert.equal(error.status, 422)
  assert.equal(error.facts.url, 'https://zt.example.com/tasks?token=***')
})
