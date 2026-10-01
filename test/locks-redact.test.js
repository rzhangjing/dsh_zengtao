/**
 * 并发保护（同对象串行）与脱敏的离线测试。
 * 这两件事都是"错了不会报错、只会静默出事"的类型，必须有断言钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { KeyedQueue, checkVersion, objectKey } from '../src/domain/locks.js'
import { redact, redactHeaders, redactUrl, ZenTaoError, asZenTaoError, codeForStatus } from '../src/domain/errors.js'

test('同对象串行：两个任务不会同时跑', async () => {
  const queue = new KeyedQueue()
  let active = 0
  let maxActive = 0
  const task = () => queue.run('bug:1', async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
  })
  await Promise.all([task(), task(), task()])
  await queue.drain()
  assert.equal(maxActive, 1, '同一 key 上必须串行')
  assert.equal(queue.pendingKeys, 0, '排空后不应残留 key')
})

test('不同对象并行：互不阻塞', async () => {
  const queue = new KeyedQueue()
  let active = 0
  let maxActive = 0
  const task = (key) => queue.run(key, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
  })
  await Promise.all([task('bug:1'), task('bug:2'), task('bug:3')])
  assert.equal(maxActive, 3, '不同 key 应并行')
})

test('前一个失败不会堵死队列（否则该对象永远写不进去）', async () => {
  const queue = new KeyedQueue()
  await assert.rejects(queue.run('bug:1', async () => { throw new Error('boom') }), /boom/)
  const result = await queue.run('bug:1', async () => 'ok')
  assert.equal(result, 'ok')
  await queue.drain()
  assert.equal(queue.pendingKeys, 0)
})

test('create 与 update 的 key 不同（新建不参与对象串行）', () => {
  assert.equal(objectKey('task', 18), 'task:18')
  assert.equal(objectKey('task', undefined), 'task:new')
  assert.notEqual(objectKey('task', 1), objectKey('bug', 1))
})

test('乐观并发校验：版本不一致必须判定失败', () => {
  assert.deepEqual(checkVersion(1, 1), { ok: true })
  assert.deepEqual(checkVersion('1', 1), { ok: true })
  assert.equal(checkVersion(1, 2).ok, false)
  assert.equal(checkVersion(undefined, 5).ok, true, '调用方没给版本就不阻断')
  assert.equal(checkVersion(1, undefined).ok, true, '服务端没返回版本就不阻断')
})

test('脱敏：敏感键整体替换，数组截断，深层限深，循环不炸', () => {
  const value = {
    token: 'secret-token',
    password: 'p',
    nested: { Set_Cookie: 'x', zentaosid: 'y', keep: 'ok' },
    list: Array.from({ length: 30 }, (_, i) => i),
    deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
  }
  value.self = value
  const out = redact(value)
  assert.equal(out.token, '***')
  assert.equal(out.password, '***')
  assert.equal(out.nested.Set_Cookie, '***')
  assert.equal(out.nested.zentaosid, '***')
  assert.equal(out.nested.keep, 'ok')
  assert.equal(out.list.length, 21) // 20 项 + "还有 10 项"
  assert.match(out.list[20], /还有 10 项/)
  assert.equal(out.self, '[circular]')
  assert.doesNotMatch(JSON.stringify(out), /secret-token/)
})

test('脱敏：超长字符串截断（避免把整个页面塞进错误消息）', () => {
  const out = redact({ body: 'x'.repeat(1000) })
  assert.match(out.body, /（已截断）$/)
  assert.ok(out.body.length < 600)
})

test('脱敏：认证头必须被剔除（v1 的认证头名字就叫 Token）', () => {
  const headers = {
    'content-type': 'application/json',
    Token: 'abc',
    'Set-Cookie': 'zentaosid=zzz',
    authorization: 'Bearer x',
  }
  const out = redactHeaders(headers)
  assert.equal(out.token, '***')
  assert.equal(out['set-cookie'], '***')
  assert.equal(out.authorization, '***')
  assert.equal(out['content-type'], 'application/json')
})

test('脱敏：URL 里的 token / zentaosid / password 被抹掉，其余保留', () => {
  assert.equal(
    redactUrl('https://zt/api.php/v1/products?page=1&token=abc&zentaosid=zzz'),
    'https://zt/api.php/v1/products?page=1&token=***&zentaosid=***',
  )
  assert.equal(redactUrl('not a url?token=abc'), 'not a url?token=***')
})

test('错误码映射与错误对象文案', () => {
  assert.equal(codeForStatus(401), 'AUTH_EXPIRED')
  assert.equal(codeForStatus(404), 'NOT_FOUND')
  assert.equal(codeForStatus(409), 'CONFLICT')
  assert.equal(codeForStatus(429), 'RATE_LIMITED')
  assert.equal(codeForStatus(503), 'NETWORK')

  const error = new ZenTaoError('CONFLICT', '对象已被他人修改。', { facts: { id: '18', token: 'zzz' } })
  const text = error.toText()
  assert.match(text, /\[CONFLICT\]/)
  assert.match(text, /建议：/)
  assert.doesNotMatch(text, /zzz/)        // facts 也走脱敏
  assert.deepEqual(error.toInfo().code, 'CONFLICT')

  const wrapped = asZenTaoError(new Error('网络炸了'))
  assert.equal(wrapped.code, 'INTERNAL')
  assert.equal(asZenTaoError(error), error)
})
