/**
 * 探测梯的离线测试。
 * 最要紧的一条：**401 不能降级**——写错会把"没登录"报成"版本不支持"，
 * 把用户引向完全错误的排查方向。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { probeDialect, looksLikeListEnvelope, detectVersion, describeProbe } from '../src/transport/probe.js'
import { createFakeTransport, listEnvelope } from './helpers.js'

const BASE = 'https://zt.example.com'

test('列表信封识别', () => {
  assert.equal(looksLikeListEnvelope({ total: 1, products: [] }), true)
  assert.equal(looksLikeListEnvelope({ products: [] }), true)
  assert.equal(looksLikeListEnvelope({ message: 'success' }), false)
  assert.equal(looksLikeListEnvelope([1, 2]), false)
  assert.equal(looksLikeListEnvelope(null), false)
})

test('命中：200 + 列表信封 → rest-v1', async () => {
  const { transport, calls } = createFakeTransport({
    'GET /products': { json: listEnvelope('products', [{ id: 1, name: 'p' }]) },
  })
  const result = await probeDialect({ transport, base: BASE, token: 'tok' })
  assert.equal(result.dialectId, 'rest-v1')
  assert.equal(result.dialectLabel, '禅道 REST v1')
  assert.equal(result.probeVersion, 1)
  assert.ok(result.probedAt)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Token, 'tok')
  assert.equal(result.facts.at(-1).outcome, 'hit')
})

test('401 → 判为"方言正确、缺凭据"，且**不再往下探**', async () => {
  const { transport, calls } = createFakeTransport({
    'GET /products': { status: 401, json: { error: 'unauthorized' } },
  })
  await assert.rejects(
    probeDialect({ transport, base: BASE, token: undefined }),
    (error) => {
      assert.equal(error.code, 'AUTH_REQUIRED')
      assert.match(error.message, /还没有可用的 API Token/)
      assert.equal(error.facts.probe[0].outcome, 'auth-required')
      return true
    },
  )
  assert.equal(calls.length, 1, '401 之后不能再请求别的方言')
})

test('带 token 的 401 → AUTH_EXPIRED', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { status: 401, json: {} },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'bad' }), /拒绝了当前 API Token/)
})

test('403 只在**所有**探测端点都被拒时才报 FORBIDDEN（否则会把可用账号挡在门外）', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { status: 403, json: { error: 'forbidden' } },
    'GET /projects': { status: 403, json: { error: 'forbidden' } },
    'GET /user': { status: 403, json: { error: 'forbidden' } },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.code, 'FORBIDDEN')
    assert.match(error.message, /都没有权限/)
    assert.match(error.hint, /至少开放/)
    return true
  })
})

test('产品列表 403 但 /user 可用 → **仍然命中**，并把被拒端点记进结论（企业版模块权限独立）', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { status: 403, json: { error: 'forbidden' } },
    'GET /projects': { status: 404, json: { error: 'not found' } },
    'GET /user': { json: { id: 1, account: 'admin', realname: '管理员' } },
  })
  const result = await probeDialect({ transport, base: BASE, token: 'tok' })
  assert.equal(result.dialectId, 'rest-v1')
  assert.equal(result.hitEndpoint, 'me', '应由 /user 兜底命中')
  assert.deepEqual(result.denied, ['product'], '产品被拒这件事必须记下来')
})

test('项目列表 403、产品 404、/user 可用 → 同样命中（不因单点失败误判方言）', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { status: 404, json: {} },
    'GET /projects': { status: 403, json: { error: 'forbidden' } },
    'GET /user': { json: { id: 1, account: 'admin' } },
  })
  const result = await probeDialect({ transport, base: BASE, token: 'tok' })
  assert.equal(result.dialectId, 'rest-v1')
  assert.equal(result.hitEndpoint, 'me')
  assert.deepEqual(result.denied, ['project'])
})

test('/user 返回的不是用户对象（形状不符）→ 不算命中', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { status: 404, json: {} },
    'GET /projects': { status: 404, json: {} },
    'GET /user': { json: { unexpected: 'shape' } },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED')
    return true
  })
})

test('401 一旦出现就停止整轮（不降级、不再试其他端点）', async () => {
  const { transport, calls } = createFakeTransport({
    'GET /products': { status: 401, json: { error: 'unauthorized' } },
    'GET /user': { json: { id: 1 } },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.code, 'AUTH_EXPIRED')
    return true
  })
  assert.equal(calls.length, 1, '401 之后不该再发任何请求')
})

test('404 → 换下一档，全败后报 UNSUPPORTED 并带完整事实', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { status: 404, json: { error: 'not found' } },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.deepEqual(error.facts.tried, ['rest-v1', 'rest-v2', 'legacy-api'])
    assert.equal(error.facts.probe[0].outcome, 'shape-mismatch')
    assert.equal(error.facts.probe[0].status, 404)
    // 未实现的方言被跳过但记录在案
    assert.ok(error.facts.probe.some((fact) => fact.outcome === 'not-implemented'))
    return true
  })
})

test('打到 HTML 登录页 → 记为 html-response（诊断里能看出"打到了网页"）', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { __html: true, status: 200 },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.equal(error.facts.probe[0].outcome, 'html-response')
    return true
  })
})

test('结构不符（JSON 但不像列表信封）→ shape-mismatch', async () => {
  const { transport } = createFakeTransport({
    'GET /products': { json: { message: 'success' } },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.facts.probe[0].outcome, 'shape-mismatch')
    return true
  })
})

test('网络失败原样抛出，并把探测事实带上', async () => {
  const transport = {
    async request () {
      const { ZenTaoError } = await import('../src/domain/errors.js')
      throw new ZenTaoError('NETWORK', '无法连接禅道：boom', { facts: { url: 'x' } })
    },
  }
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok' }), (error) => {
    assert.equal(error.code, 'NETWORK')
    assert.deepEqual(error.facts.probe, [])
    return true
  })
})

test('手工指定 dialect 时只试那一档（且该档内会试完所有探测端点）', async () => {
  const { transport, calls } = createFakeTransport({
    'GET /products': { status: 404, json: {} },
    'GET /projects': { status: 404, json: {} },
    'GET /user': { status: 404, json: {} },
  })
  await assert.rejects(probeDialect({ transport, base: BASE, token: 'tok', configured: 'rest-v1' }))
  assert.equal(calls.length, 3, '只试指定的那一档，但该档的三个探测端点都试')
  for (const call of calls) {
    assert.match(call.pathname, /^\/api\.php\/v1\//, '每次探测都必须带 API 前缀')
  }
})

test('版本串只在明确时才给出（不猜）', () => {
  assert.equal(detectVersion({ headers: { 'x-zentao-version': '18.5' } }), '18.5')
  assert.equal(detectVersion({ headers: {}, json: { version: '20.1' } }), '20.1')
  assert.equal(detectVersion({ headers: { 'x-powered-by': 'PHP/8.1' }, json: {} }), undefined)
})

test('describeProbe 输出中文事实表', () => {
  const text = describeProbe({
    dialectId: 'rest-v1',
    dialectLabel: '禅道 REST v1',
    probedAt: '2026-03-10T00:00:00.000Z',
    facts: [{ dialect: 'rest-v1', outcome: 'hit', status: 200 }],
  })
  assert.match(text, /禅道 REST v1/)
  assert.match(text, /探测过程/)
  assert.match(text, /HTTP 200/)
})
