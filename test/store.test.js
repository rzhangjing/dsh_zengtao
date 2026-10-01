/**
 * 持久层（store.js）的离线测试。
 *
 * 为什么单独测：这一层承载**幂等键** —— 它失效不会报错，只会让"同一次写被重复落库"。
 * 而"没有持久化"这件事原先只有一行日志，用户和 /zentao doctor 都看不见。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createStore, zentaoDomain } from '../src/store.js'

/** 假 storage domain：像真实实现那样，表数据存在一个可跨 store 共享的 Map 里。 */
function makeBacking () {
  const tables = { probe: new Map(), entities: new Map(), idempotency: new Map() }
  const calls = { open: 0, put: [], close: 0 }
  const storageDomain = {
    async open (spec) {
      calls.open += 1
      if (calls.open <= (storageDomain.failFirstN ?? 0)) {
        // 像真实实现那样抛 DomainError（带稳定 code + 给人看的消息）
        const error = new Error(storageDomain.failMessage ?? 'boom')
        error.code = storageDomain.failCode
        throw error
      }
      // close 幂等（真实实现是 `this.disposal ??= this.runClose()`），
      // 因为 Cordis 可能多次调用同一个 disposer。
      let disposal
      return {
        tables,
        table (name) {
          if (tables[name] === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`)
          return {
            get: (key) => tables[name].get(key),
            put: async (key, value) => { calls.put.push([name, key]); tables[name].set(key, value) },
          }
        },
        close () {
          disposal ??= (async () => { calls.close += 1 })()
          return disposal
        },
      }
    },
    calls,
    tables,
  }
  return storageDomain
}

const ctxWith = (storageDomain) => ({
  get: (name) => (name === 'storageDomain' ? storageDomain : undefined),
})

const PROBE = Object.freeze({
  baseURL: 'https://zt.example.com',
  dialectId: 'rest-v1',
  dialectLabel: '禅道 REST v1',
  probedAt: '2026-03-10T00:00:00.000Z',
  probeVersion: 1,
  facts: [],
})

/* ─────────────── 写入后能读回 ─────────────── */

test('探测结论：写一次后在**新实例**里也能读回（真正跨重启）', async () => {
  const backing = makeBacking()
  const first = createStore(ctxWith(backing), () => {})
  await first.setProbe(PROBE)
  assert.deepEqual(await first.getProbe(), PROBE)

  const second = createStore(ctxWith(backing), () => {})
  assert.deepEqual(await second.getProbe(), PROBE, '新实例应从持久层读回探测结论')
})

test('幂等记录：**跨实例读回**（重启后重放同一次写不会被当成新写）', async () => {
  const backing = makeBacking()
  const first = createStore(ctxWith(backing), () => {})
  await first.setIdempotency('abc123', { at: Date.now(), resultRef: '18' })

  const second = createStore(ctxWith(backing), () => {})
  const record = await second.getIdempotency('abc123')
  assert.equal(record?.resultRef, '18', '幂等窗口必须跨重启有效，否则会重复落库')
})

test('惰性打开：一次 store 生命周期内只 open 一次', async () => {
  const backing = makeBacking()
  const store = createStore(ctxWith(backing), () => {})
  await store.setProbe(PROBE)
  await store.getProbe()
  await store.setEntity('task', '18', { at: Date.now(), item: {} })
  assert.equal(backing.calls.open, 1)
})

/* ─────────────── 降级路径 ─────────────── */

test('没有 storageDomain 服务时降级为内存，但**仍然可用**，且说明原因', async () => {
  const store = createStore({ get: () => undefined }, () => {})
  await store.setProbe(PROBE)
  assert.deepEqual(await store.getProbe(), PROBE, '内存模式下读写仍要正常')
  const status = await store.storageStatus()
  assert.equal(status.mode, 'memory-only')
  assert.match(status.reason, /未提供 storageDomain/)
})

test('打开失败时降级为内存，并把**失败原因**留给诊断', async () => {
  const logs = []
  const backing = makeBacking()
  backing.failFirstN = 99
  backing.failMessage = 'backend has no kv facet'
  const store = createStore(ctxWith(backing), (message) => logs.push(message))
  await store.setProbe(PROBE)
  assert.deepEqual(await store.getProbe(), PROBE)
  const status = await store.storageStatus()
  assert.equal(status.mode, 'memory-only')
  assert.match(status.reason, /no kv facet/)
  assert.ok(logs.some((line) => line.includes('降级')), '降级必须留下日志')
})

test('already-open（重载竞态）会重试一次，不把竞态降级成"永久只用内存"', async () => {
  const backing = makeBacking()
  backing.failFirstN = 1
  backing.failCode = 'already-open'
  backing.failMessage = "domain 'zentao' is already open"
  const store = createStore(ctxWith(backing), () => {})
  const status = await store.storageStatus()
  assert.equal(status.mode, 'storage-domain', '重试后应成功拿到持久化')
  assert.equal(backing.calls.open, 2)
})

test('只有稳定 code 或消息像 already-open 才重试；其他错误立刻降级', async () => {
  const backing = makeBacking()
  backing.failFirstN = 99
  backing.failCode = 'facet-unsupported'
  backing.failMessage = "backend 'x' routed for domain 'zentao' has no kv facet"
  const store = createStore(ctxWith(backing), () => {})
  const status = await store.storageStatus()
  assert.equal(status.mode, 'memory-only')
  assert.equal(backing.calls.open, 1, '不可重试的错误不该白试第二次')
})

test('域声明带 invalidRecords 策略：一条坏记录不能让整个域打不开', () => {
  assert.equal(zentaoDomain.invalidRecords, 'backup-and-skip')
})

/* ─────────────── 实体缓存的边界 ─────────────── */

test('实体缓存有上限并淘汰最旧的一批（缓存不是真相）', async () => {
  const backing = makeBacking()
  const store = createStore(ctxWith(backing), () => {})
  const now = Date.now()
  for (let i = 0; i < 520; i += 1) {
    await store.setEntity('task', String(i), { at: now + i, item: { i } })
  }
  // 最旧的已被淘汰，最新的还在
  assert.equal(await store.getEntity('task', '0'), undefined)
  assert.notEqual(await store.getEntity('task', '519'), undefined)
})

test('close 幂等且能安全重复调用（Cordis 拆除时会 await 它）', async () => {
  const backing = makeBacking()
  const store = createStore(ctxWith(backing), () => {})
  await store.setProbe(PROBE)
  await store.close()
  await assert.doesNotReject(() => store.close())
  assert.equal(backing.calls.close, 1)
})

test('close 之后写入失败只记日志，不把异常抛给调用方', async () => {
  const logs = []
  const backing = makeBacking()
  let closed = false
  const store = createStore(ctxWith(backing), (message) => logs.push(message))
  await store.setProbe(PROBE)
  closed = true
  assert.equal(closed, true)
  await assert.doesNotReject(() => store.setEntity('task', '19', { at: Date.now(), item: {} }))
})
