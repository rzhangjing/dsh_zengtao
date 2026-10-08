/**
 * 服务层离线测试：扫描/过滤/分页、以及**写入的四层保护**
 * （dryRun 默认、字段白名单、幂等、乐观并发 + 同对象串行 + 强制回读）。
 *
 * 这是整个插件里最值得被测试的部分：错误在这里不会抛异常，只会静默写错数据。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createService, SCAN_BOUNDS } from '../src/service.js'
import { KeyedQueue } from '../src/domain/locks.js'
import { renderItem, renderList, renderWriteResult } from '../src/domain/render.js'
import { normalizeItem } from '../src/domain/normalize.js'
import { createFakeTransport, createMemoryStore, fakeConfig, listEnvelope, rawTask } from './helpers.js'

const EXECUTION = '13'

/** 造一个"会随写入变化"的世界，让回读与版本号有真实语义。 */
function makeWorld () {
  const tasks = new Map([
    [18, rawTask({ id: 18, execution: 13, status: 'doing', version: 1, pri: 3, name: '已有任务' })],
  ])
  const putCalls = []
  const routes = {
    'GET /executions/13/tasks': ({ params }) => {
      const list = [...tasks.values()].map((task) => ({ ...task }))
      return {
        json: listEnvelope('tasks', list, {
          page: Number(params.get('page') ?? 1),
          limit: Number(params.get('limit') ?? 50),
          total: list.length,
        }),
      }
    },
    // 看板路径需要：需求挂执行、执行详情（拿它关联的产品）
    'GET /executions/13/stories': () => ({ json: listEnvelope('stories', [{ id: 31, title: '迭代需求', status: 'active', pri: 2 }]) }),
    'GET /executions/13': () => ({ json: { id: 13, project: 12, product: 1, name: '迭代1', status: 'doing' } }),
    'GET /tasks/18': () => ({ json: { ...tasks.get(18) } }),
    'GET /tasks/99': () => ({ json: { id: 99, name: '新任务', status: 'wait', version: 1 } }),
    'GET /tasks/777': () => ({ status: 404, json: { error: 'not found' } }),
    'PUT /tasks/18': ({ body }) => {
      putCalls.push(body)
      const current = tasks.get(18)
      // 模拟"服务器只接受文档化字段"：未知字段被忽略
      const applied = {}
      for (const key of ['name', 'pri', 'estimate', 'deadline', 'assignedTo', 'module', 'type', 'estStarted', 'story', 'fromBug']) {
        if (body[key] !== undefined) applied[key] = body[key]
      }
      const next = { ...current, ...applied, version: (current.version ?? 1) + 1 }
      tasks.set(18, next)
      return { json: { ...next } }
    },
    'POST /executions/13/tasks': ({ body }) => {
      tasks.set(99, { id: 99, execution: 13, name: body.name, status: 'wait', version: 1 })
      return { json: { id: 99 } }
    },
    'GET /user': () => ({ json: { id: 1, account: 'admin', realname: 'administrator' } }),
    'GET /projects': () => ({ json: listEnvelope('projects', [{ id: 12, name: '项目A', status: 'doing' }]) }),
    'GET /projects/12/executions': () => ({ json: listEnvelope('executions', [{ id: 13, name: '迭代1', status: 'doing' }]) }),
    'GET /products': () => ({ json: listEnvelope('products', [{ id: 1, name: '产品A', status: 'normal' }]) }),
    'GET /products/1/bugs': () => ({
      json: listEnvelope('bugs', [
        { id: 501, title: '登录白屏', status: 'active', pri: 1, version: 2, assignedTo: { id: 1, account: 'admin', realname: 'administrator' } },
      ]),
    }),
  }
  return { tasks, putCalls, routes }
}

function makeService (world, overrides = {}) {
  const fake = createFakeTransport(world.routes, { delayMs: overrides.delayMs ?? 0 })
  const store = createMemoryStore()
  const service = createService({
    transport: fake.transport,
    store,
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0, ...(overrides.config ?? {}) }),
    getToken: async () => 'test-token',
    getSessionContext: () => overrides.sessionContext,
    logger: () => {},
  })
  return { service, fake, store }
}

/* ─────────────────────────── 读 ─────────────────────────── */

test('query：按范围与本地过滤取列表，并做本地分页', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].ref.id, '18')
  assert.equal(result.entityLabel, '任务')
  assert.equal(result.page, 1)
  assert.equal(result.hasMore, false)
  assert.equal(result.partial, false)
})

test('query：缺范围时明确报 VALIDATION（端点形态所限）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  await assert.rejects(service.query({ entity: 'task' }), (error) => {
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, /必须指定范围/)
    return true
  })
})

test('query：可由 /zentao switch 的会话上下文补全省略的 scope', async () => {
  const world = makeWorld()
  const { service } = makeService(world, { sessionContext: { productId: '1', executionId: EXECUTION } })
  const result = await service.query({ entity: 'task' })
  assert.equal(result.items.length, 1)
})

test('query：过滤键非法时报错并列出可用键', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  await assert.rejects(service.query({ entity: 'task', scope: { execution: EXECUTION }, filters: { nope: 1 } }), /不认识的键/)
})

test('query：扫描触到页数上限时**如实报 partial**，不假装没有更多', async () => {
  const big = Array.from({ length: 50 }, (_, i) => rawTask({ id: 1000 + i, execution: 13, status: 'doing' }))
  const fake = createFakeTransport({
    'GET /executions/13/tasks': ({ params }) => ({
      json: listEnvelope('tasks', big, {
        page: Number(params.get('page') ?? 1),
        limit: Number(params.get('limit') ?? 50),
        total: 1000,
      }),
    }),
  })
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0 }),
    getToken: async () => 't',
  })
  // 第 6 页需要 300 条，但扫描上限只给 5 页（250 条）→ 必须报 partial
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION }, pageSize: 50, page: 6 })
  assert.equal(result.partial, true)
  assert.match(result.partialNote, new RegExp(`${SCAN_BOUNDS.maxPagesPerList} 页上限`))
  assert.equal(fake.callsTo('GET /executions/13/tasks').length, SCAN_BOUNDS.maxPagesPerList)
})

test('get：返回版本号（供写入时传回）并说明未实现的 expand', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.get({ entity: 'task', id: '18', expand: ['comments'] })
  assert.equal(result.item.version, 1)
  assert.match(result.notes.join(''), /评论/)
  assert.match(result.notes.join(''), /没做/)
})

test('my：先解析当前用户，再逐个执行/产品扫描并本地匹配指派人', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.my({ include: ['task', 'bug'] })
  assert.equal(result.user, 'administrator')
  assert.equal(result.groups.length, 2)
  const taskGroup = result.groups.find((group) => group.entity === 'task')
  assert.equal(taskGroup.items.length, 1, '任务按指派人匹配到 1 条')
  const bugGroup = result.groups.find((group) => group.entity === 'bug')
  assert.equal(bugGroup.items.length, 1)
  assert.match(result.notes.join(''), /已扫描/)
})

test('doctor：显示**命中端点**（复用 describeProbe，而不是另抄一份输出）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.doctor({})
  assert.match(result.text, /命中端点：product/)
  assert.match(result.text, /探测过程/)
})

test('doctor：产品与项目端点都 403 但 /user 可用时，仍然给出方言，并列出**被拒端点**', async () => {
  const world = makeWorld()
  world.routes['GET /products'] = () => ({ status: 403, json: { error: 'forbidden' } })
  world.routes['GET /projects'] = () => ({ status: 403, json: { error: 'forbidden' } })
  const { service } = makeService(world)
  const result = await service.doctor({})
  assert.equal(result.ok, true, '模块无权限不该让整个诊断失败')
  assert.match(result.text, /命中端点：me/, '应由 /user 兜底命中')
  assert.match(result.text, /被拒端点.*product.*project/)
})


test('doctor：输出方言、写形状校准状态与当前账号', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.doctor({})
  assert.equal(result.ok, true)
  assert.match(result.text, /方言/)
  assert.match(result.text, /写操作形状校准/)
  assert.match(result.text, /administrator/)
  assert.match(result.text, /NODE_EXTRA_CA_CERTS/)
})

test('doctor：必须报告**持久化状态与降级原因**（降级会缩短幂等窗口，用户有知情权）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.doctor({})
  assert.match(result.text, /持久化：仅内存/)
  assert.match(result.text, /测试夹具/, '必须把具体原因说出来，而不是只说"仅内存"')
  assert.equal(result.facts.persistence.mode, 'memory-only')
})

/* ─────────────────────────── 写 ─────────────────────────── */

test('dryRun 默认：只回显请求，绝不发写请求', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } },
  })
  assert.equal(result.dryRun, true)
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0].method, 'PUT')
  assert.equal(result.steps[0].path, '/api.php/v1/tasks/18')
  assert.equal(result.verified, true)
  assert.equal(fake.callsTo('PUT /tasks/18').length, 0, 'dryRun 不允许写入')
})

test('真实写入：写入 → 强制回读 → 无差异', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false,
  })
  assert.equal(result.results[0].ok, true)
  assert.deepEqual(result.results[0].diff, [])
  assert.equal(fake.callsTo('PUT /tasks/18').length, 1)
  assert.equal(fake.callsTo('GET /tasks/18').length >= 2, true, '写前读一次 + 写后回读一次')
})

test('写入后回读不一致 → 如实报差异（不谎报成功）', async () => {
  const world = makeWorld()
  // 让服务器忽略 pri（模拟"字段没生效"）
  world.routes['PUT /tasks/18'] = ({ body }) => {
    const current = world.tasks.get(18)
    const next = { ...current, name: body.name ?? current.name, version: (current.version ?? 1) + 1 }
    world.tasks.set(18, next)
    return { json: { ...next } }
  }
  const { service } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false,
  })
  assert.equal(result.results[0].ok, true)
  assert.match(result.results[0].diff.join('，'), /pri 期望 1 实际 3/)
})

test('乐观并发：expectedVersion 不匹配 → CONFLICT，且**不发写入请求**', async () => {
  const world = makeWorld()
  world.tasks.set(18, rawTask({ id: 18, status: 'doing', version: 7 }))
  const { service, fake } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } },
    expectedVersion: '1', dryRun: false,
  })
  assert.equal(result.results[0].ok, false)
  assert.equal(result.results[0].errorCode, 'CONFLICT')
  assert.equal(fake.callsTo('PUT /tasks/18').length, 0)
})

test('D7 对冲：两个并发写者对同一对象 → 一个成功、一个 CONFLICT，绝不丢更新', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world, { delayMs: 5 })
  const [first, second] = await Promise.all([
    service.write({ action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, expectedVersion: '1', dryRun: false }),
    service.write({ action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 2 } }, expectedVersion: '1', dryRun: false }),
  ])
  const results = [first.results[0], second.results[0]]
  assert.equal(results.filter((item) => item.ok).length, 1, '只能有一个成功')
  assert.equal(results.filter((item) => item.errorCode === 'CONFLICT').length, 1)
  assert.equal(fake.callsTo('PUT /tasks/18').length, 1, '冲突方不得写入')
})

test('幂等：同参数重复写入在窗口内不重复落库', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  const args = { action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false }
  const first = await service.write(args)
  const second = await service.write(args)
  assert.equal(first.results[0].idempotent, false)
  assert.equal(second.results[0].idempotent, true)
  assert.equal(fake.callsTo('PUT /tasks/18').length, 1)
})

test('幂等命中（create）：必须回**上次创建记录的 id** —— 曾经返回 undefined（真机实测发现）', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  const payload = { execution: '13', name: '幂等新建任务', type: 'devel', estStarted: '2026-01-01', deadline: '2026-01-10' }
  const first = await service.write({ action: 'create', entity: 'task', payload, dryRun: false })
  const second = await service.write({ action: 'create', entity: 'task', payload, dryRun: false })
  assert.equal(first.results[0].ok, true)
  assert.ok(first.results[0].id, '第一次必须有 id')
  assert.equal(second.idempotent, true, '第二次应命中幂等')
  assert.equal(second.results[0].id, first.results[0].id,
    '幂等命中必须回同一个 id（create 的入参里没有 id，必须用记下的 resultRef）')
  assert.equal(fake.callsTo('POST /executions/13/tasks').length, 1, '绝不能发第二次创建请求')
})

test('乐观并发：基线也接受 updatedAt 时间戳（实测本机 version 不递增，时间戳才是可用令牌）', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  const baseline = world.tasks.get(18).lastEditedDate
  // 基线一致 → 允许写
  const okResult = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } },
    expectedVersion: baseline, dryRun: false,
  })
  assert.equal(okResult.results[0].ok, true)
  const call = fake.callsTo('PUT /tasks/18')[0]
  assert.equal(call.body.version, undefined, '时间戳是本地比对用的，不该当成 version 字段发给禅道')

  // 对象自读取后被改过（lastEditedDate 变了）→ CONFLICT，且**不发写请求**
  world.tasks.set(18, { ...world.tasks.get(18), lastEditedDate: '2026-02-02T00:00:00Z' })
  const before = fake.callsTo('PUT /tasks/18').length
  const conflict = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 2 } },
    expectedVersion: baseline, dryRun: false,
  })
  assert.equal(conflict.results[0].errorCode, 'CONFLICT')
  assert.match(conflict.results[0].errorMessage, /自你读取后已被修改/)
  assert.equal(fake.callsTo('PUT /tasks/18').length, before, '冲突时绝不能发写请求')
})

test('字段白名单：改任务状态被拒绝，并提示正确的做法', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  await assert.rejects(
    service.write({ action: 'update', entity: 'task', id: '18', payload: { patch: { status: 'closed' } }, dryRun: false }),
    (error) => {
      assert.equal(error.code, 'VALIDATION')
      assert.match(error.message, /不接受这些字段.*status/)
      assert.match(error.hint, /start\/finish/)
      return true
    },
  )
})

test('新建任务必须给出执行；给出后可写入并回读到新对象', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  await assert.rejects(
    service.write({ action: 'create', entity: 'task', payload: { name: 'x' }, dryRun: false }),
    /必须给出所属执行/,
  )
  const result = await service.write({
    action: 'create', entity: 'task',
    payload: { execution: EXECUTION, name: '新任务', type: 'devel' },
    dryRun: false,
  })
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].id, '99')
  assert.equal(fake.callsTo('POST /executions/13/tasks').length, 1)
})

test('create 的 dryRun 会显示真实请求行（含父资源路径）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.write({
    action: 'create', entity: 'bug',
    payload: { product: '1', title: 'b', severity: 1, pri: 1, type: 'codeerror' },
  })
  assert.equal(result.steps[0].path, '/api.php/v1/products/1/bugs')
  assert.equal(result.steps[0].body.title, 'b')
})

test('批量：部分失败时逐条如实汇报（不整体失败、也不整体重试）', async () => {
  const world = makeWorld()
  const { service } = makeService(world, { config: { allowBulkWrite: true } })
  const result = await service.write({
    action: 'update', entity: 'task',
    bulk: [{ id: '18', payload: { patch: { pri: 1 } } }, { id: '777', payload: { patch: { pri: 2 } } }],
    dryRun: false,
  })
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[1].ok, false)
  assert.equal(result.results[1].errorCode, 'NOT_FOUND')
  assert.equal(result.partial, true)
})

test('批量默认关闭（allowBulkWrite=false）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  await assert.rejects(
    service.write({ action: 'update', entity: 'task', bulk: [{ id: '18' }, { id: '19' }], dryRun: false }),
    /批量写当前被禁用/,
  )
})

test('关闭类必须给 reason（避免无声变更）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  await assert.rejects(
    service.write({ action: 'close', entity: 'task', id: '18', dryRun: false }),
    /必须提供 reason/,
  )
})

test('start/finish 的必填字段在服务层就被拦下（不打无谓的请求）', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  await assert.rejects(service.write({ action: 'start', entity: 'task', id: '18', payload: {}, dryRun: false }), /left/)
  await assert.rejects(service.write({ action: 'finish', entity: 'task', id: '18', payload: { currentConsumed: 1 }, dryRun: false }), /finishedDate/)
  assert.equal(fake.callsTo('POST /tasks/18/start').length, 0)
})

test('**所有请求都必须带 /api.php/v1 前缀**（曾因没人用方言的 basePath 而全部发到站点根）', async () => {
  const world = makeWorld()
  const { service, fake } = makeService(world)
  await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  await service.get({ entity: 'task', id: '18' })
  await service.my({ include: ['task', 'bug'] })
  await service.board({ scope: 'execution', id: EXECUTION })
  assert.ok(fake.calls.length > 0)
  const bad = fake.calls.filter((call) => !call.pathname.startsWith('/api.php/v1/'))
  assert.deepEqual(bad.map((call) => `${call.method} ${call.pathname}`), [],
    '这些请求少了 API 前缀，在真机上会 404')
})

test('写操作不支持非文档化实体（如给用户建任务）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  await assert.rejects(
    service.write({ action: 'resolve', entity: 'task', id: '18', payload: { resolution: 'fixed' }, dryRun: false }),
    /不支持实体/,
  )
})

/* ─────────────── "根本不是接口"必须报错，不能静默给空结果 ─────────────── */

test('2xx 但返回 HTML（登录页/网页）→ 明确报错，而不是"0 条结果"', async () => {
  const world = makeWorld()
  world.routes['GET /executions/13/tasks'] = () => ({ __html: true, status: 200 })
  const { service } = makeService(world)
  await assert.rejects(
    service.query({ entity: 'task', scope: { execution: EXECUTION } }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /返回的是网页/)
      assert.match(error.hint, /子目录/, 'hint 必须点出最常见的成因（baseURL 少了子目录）')
      return true
    },
  )
})

test('2xx 但不是 JSON（网关/代理改写）→ 明确报错，且不把响应体带进错误信息', async () => {
  const world = makeWorld()
  // 2xx + 空体：content-type 仍是 application/json，但不是可解析的 JSON
  world.routes['GET /products'] = () => ({ __empty: true, status: 200 })
  const { service } = makeService(world)
  await assert.rejects(
    service.query({ entity: 'product' }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /不是 JSON/)
      assert.doesNotMatch(JSON.stringify(error), /login|token|password/i, '错误信息里不能混入响应体内容')
      return true
    },
  )
})

test('写请求的**空体 200 是合法的**（DELETE 成功可能没有内容），不能被当成"不是 JSON"', async () => {
  const world = makeWorld()
  world.routes['DELETE /tasks/18'] = () => ({ __empty: true, status: 200 })
  const { service, fake } = makeService(world)
  const result = await service.write({ action: 'delete', entity: 'task', id: '18', reason: '误建', dryRun: false })
  assert.equal(result.results[0].ok, true, '空体 200 必须判为成功')
  assert.equal(fake.callsTo('DELETE /tasks/18').length, 1)
})

test('策略承诺：close/resolve 的 reason **必须真的进到请求体**（否则就是它要防的"无声变更"）', async () => {
  const world = makeWorld()
  world.routes['POST /tasks/18/close'] = () => ({ json: { id: 18, status: 'closed' } })
  world.routes['GET /tasks/18'] = () => ({ json: { id: 18, name: 't', execution: 13, status: 'closed' } })
  const { service, fake } = makeService(world)
  const result = await service.write({ action: 'close', entity: 'task', id: '18', reason: '需求变更，关闭', dryRun: false })
  assert.equal(result.results[0].ok, true)
  const call = fake.callsTo('POST /tasks/18/close')[0]
  assert.ok(call, '应当真的发出关闭请求')
  // 服务层把 reason 注入 payload.reason，方言必须把它落到禅道认识的 comment 上
  assert.equal(call.body.comment, '需求变更，关闭', 'reason 没有进请求体 —— 那就是无声变更')
  assert.equal(call.body.reason, undefined, 'reason 不该作为未知字段发出去')
})

test('renderList：形状提示与"扫描未完成"都必须渲染给用户（有结果与空结果两种路径）', () => {
  const item = normalizeItem('task', rawTask({ id: 18, execution: 13 }))
  const withItems = renderList({
    entityLabel: '任务', items: [item], total: 1,
    partial: true, partialNote: '扫描未完成', shapeNote: '集合键是 data',
  })
  assert.match(withItems, /形状提示/)
  assert.match(withItems, /扫描未完成/)

  const empty = renderList({
    entityLabel: '任务', items: [], partial: true, partialNote: '扫描未完成', shapeNote: '集合键是 data',
  })
  assert.match(empty, /没有匹配项/)
  assert.match(empty, /形状提示/, '空结果时也要把形状提示带出来（否则用户以为真的没有数据）')
  assert.match(empty, /扫描未完成/)
})

test('真实形状：GET /user 返回 {"profile":{…}} —— 当前用户必须能解出来（实测校准）', async () => {
  const world = makeWorld()
  // 真实响应（本机禅道 IPD 版实测）：当前用户被包在 profile 键里
  world.routes['GET /user'] = () => ({
    json: {
      profile: {
        id: '2', account: 'admin', realname: 'admin', company: '0', type: 'inside', dept: '0',
        role: { code: '', name: '' }, email: '', gender: 'f',
      },
    },
  })
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  const me = await service.currentUser({})
  assert.equal(me.ref.id, '2', 'profile.id 必须被解出来')
  assert.equal(me.title, 'admin', 'realname 应成为显示名')
  assert.equal(me.identity.account, 'admin')
  assert.equal(me.identity.realname, 'admin')
})

test('真实形状：/user 的 profile 包装下，zentao_my 仍能正确匹配指派人（实测校准）', async () => {
  const world = makeWorld()
  world.routes['GET /user'] = () => ({ json: { profile: { id: '2', account: 'admin', realname: 'admin' } } })
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [
      rawTask({ id: 18, execution: 13, assignedTo: { id: 2, account: 'admin', realname: 'admin' } }),
      rawTask({ id: 19, execution: 13, assignedTo: { id: 3, account: 'dev', realname: '开发' } }),
    ], { total: 2 }),
  })
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  const result = await service.my({ include: ['task'] })
  const ids = result.groups.flatMap((group) => group.items.map((item) => item.ref.id))
  assert.deepEqual(ids, ['18'], '只应拿到 admin 自己的任务')
  assert.equal(result.user, 'admin')
  assert.ok(result.matchedBy.includes('admin'))
})

test('真实形状：/users 列表项只有 {account, realname}（无 id）时仍能正常归一化', async () => {
  const world = makeWorld()
  world.routes['GET /users'] = () => ({ json: { page: 1, total: 1, limit: 3, users: [{ account: 'admin', realname: 'admin' }] } })
  const { service, fake } = makeService(world, { cacheTtlSeconds: 0 })
  const result = await service.query({ entity: 'user', pageSize: 3 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].title, 'admin', 'realname 应成为标题')
  assert.equal(result.items[0].ref.id, undefined, '禅道在用户列表里不返回 id —— 这是数据，不是形状错误')
  assert.equal(result.envelopeKey, 'users')
  // 请求侧的 limit 用的是**扫描页大小**（config.maxPageSize），不是结果分页的 pageSize ——
  // 因为过滤在本地做，必须一次多取一些。`limit` 是已实测确认的参数名。
  assert.equal(fake.callsTo('GET /users')[0].search.get('limit'), '50')
})

test('doctor：写形状清单**不能出现 undefined**（真实缺陷已修：曾打印不存在的 method 字段）', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.doctor({})
  assert.match(result.text, /写操作形状校准/)
  assert.doesNotMatch(result.text, /undefined/, '诊断输出里不该出现 undefined')
  // 曾经这里打印 `start（Bug）`：那是**按硬编码的实体列表**问出来的"未校准"，
  // 而 start/finish 根本不支持 bug（禅道路由表里没有 /bugs/:id/start）。
  // 实体列表现在取自 model.js 的权威声明，所以该动作的受支持实体全都已校准 → 不再出现在清单里。
  assert.doesNotMatch(result.text, /start（/, 'start 只支持 task，不该列出 bug 这种不存在的组合')
  assert.doesNotMatch(result.text, /finish（/, 'finish 同理')
  // 已实测确认的组合必须从"未确认"清单里消失
  assert.doesNotMatch(result.text, /assign（/, 'assign×task/bug 已实测确认，不该再列为未确认')
  assert.doesNotMatch(result.text, /resolve（/, 'resolve×bug 已实测确认')
  assert.doesNotMatch(result.text, /close（/, 'close 已对 Bug/任务/需求全部实测确认')
  assert.doesNotMatch(result.text, /log_effort（/, '工时端点已在真机跑通（/tasks|bugs|stories/:id/estimate）')
  assert.match(result.text, /comment（需求、任务、Bug）/, 'comment 已被实测反证，仍是未确认形状')
  assert.match(result.text, /1 项尚未实测校准/, '本机实测后只剩 comment 一项')
})

test('响应信封**完全没有数组**但 total>0 时自诊断报错，并把实际信封键名带出来', async () => {
  const world = makeWorld()
  // 集合被嵌套了一层（data.tasks），声明的键与"第一个数组值"都取不到
  world.routes['GET /executions/13/tasks'] = () => ({
    json: { page: 1, total: 5, limit: 50, data: { tasks: [{ id: 1 }, { id: 2 }] } },
  })
  const { service } = makeService(world)
  await assert.rejects(
    service.query({ entity: 'task', scope: { execution: EXECUTION } }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /total=5/)
      assert.deepEqual(error.facts.envelopeKeys, ['page', 'total', 'limit', 'data'], '必须把实际信封键名带出来')
      assert.equal(error.facts.expectedKey, 'tasks')
      return true
    },
  )
})

test('集合键与预期不同（data 而非 tasks）时**容错读取成功**，并把差异作为校准信号报出来', async () => {
  const world = makeWorld()
  world.routes['GET /executions/13/tasks'] = () => ({
    json: { page: 1, total: 1, limit: 50, data: [rawTask({ id: 18, execution: 13 })] },
  })
  const { service } = makeService(world)
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  assert.equal(result.items.length, 1, 'pickArray 的容错应取到 data 里的条目')
  assert.equal(result.envelopeKey, 'data')
  assert.match(result.shapeNote, /「data」而不是预期的「tasks」/)
})

test('集合键与预期一致时不产生校准提示', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  assert.equal(result.envelopeKey, 'tasks')
  assert.equal(result.shapeNote, undefined)
})

test('total=0 且 0 条是**正常空结果**，不能误报形状错误', async () => {
  const world = makeWorld()
  world.routes['GET /executions/13/tasks'] = () => ({ json: listEnvelope('tasks', [], { total: 0 }) })
  const { service } = makeService(world)
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  assert.equal(result.items.length, 0)
  assert.equal(result.matchedTotal, 0)
})

test('翻到超出末尾的页（total>0 但本页 0 条）不能误报形状错误', async () => {
  const world = makeWorld()
  const list = [rawTask({ id: 18, execution: 13 })]
  world.routes['GET /executions/13/tasks'] = ({ params }) => ({
    json: listEnvelope('tasks', Number(params.get('page') ?? 1) === 1 ? list : [], { total: 1, limit: 1 }),
  })
  const { service } = makeService(world)
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION }, page: 2, pageSize: 1 })
  assert.ok(result, '第二页为空是正常的，不应报错')
})


/* ─────────────── 详情形状：没有 id 就不能算"查到了" ─────────────── */

test('详情响应为 null（禅道可能对不存在的编号返回 200 + null）→ NOT_FOUND，而不是渲染全 undefined 的结果', async () => {
  const world = makeWorld()
  // 用 __body 指定精确响应体：普通的 json null 会被夹具的 `??` 兜底吞掉
  world.routes['GET /tasks/18'] = () => ({ __body: null })
  const { service } = makeService(world)
  await assert.rejects(
    service.get({ entity: 'task', id: '18' }),
    (error) => {
      assert.equal(error.code, 'NOT_FOUND')
      assert.match(error.message, /没有返回任务 #18 的内容/)
      return true
    },
  )
})

test('详情响应为空对象 → 同样报 NOT_FOUND', async () => {
  const world = makeWorld()
  world.routes['GET /tasks/18'] = () => ({ json: {} })
  const { service } = makeService(world)
  await assert.rejects(service.get({ entity: 'task', id: '18' }), (error) => {
    assert.equal(error.code, 'NOT_FOUND')
    return true
  })
})

test('详情响应有内容但没有 id → UNSUPPORTED 并带出信封键名（形状假设不成立）', async () => {
  const world = makeWorld()
  world.routes['GET /tasks/18'] = () => ({ json: { unexpected: 'shape', hint: 'no id here' } })
  const { service } = makeService(world)
  await assert.rejects(
    service.get({ entity: 'task', id: '18' }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /没有 id 字段/)
      assert.deepEqual(error.facts.envelopeKeys, ['unexpected', 'hint'])
      return true
    },
  )
})

test('200 响应带 error 键时走**业务错误**路径（不是形状错误）—— 两者要分清', async () => {
  const world = makeWorld()
  world.routes['GET /tasks/18'] = () => ({ json: { error: '你没有权限查看该任务' } })
  const { service } = makeService(world)
  await assert.rejects(
    service.get({ entity: 'task', id: '18' }),
    (error) => {
      assert.equal(error.code, 'VALIDATION')
      assert.match(error.message, /被禅道拒绝.*没有权限/)
      return true
    },
  )
})

test('详情被包一层或被放进数组时仍然读得到（既有容错必须保留）', async () => {
  const world = makeWorld()
  world.routes['GET /tasks/18'] = () => ({ json: { tasks: { id: 18, name: '包一层', status: 'doing' } } })
  const { service } = makeService(world)
  const wrapped = await service.get({ entity: 'task', id: '18' })
  assert.equal(wrapped.item.ref.id, '18')

  const world2 = makeWorld()
  world2.routes['GET /tasks/18'] = () => ({ json: [{ id: 18, name: '在数组里', status: 'doing' }] })
  const { service: service2 } = makeService(world2)
  const inArray = await service2.get({ entity: 'task', id: '18' })
  assert.equal(inArray.item.ref.id, '18')
})

test('并发前置读拿到不认识的对象时**中止写入**，不能静默跳过版本校验', async () => {
  const world = makeWorld()
  world.routes['GET /tasks/18'] = () => ({ json: { unexpected: 'shape' } })
  const { service, fake } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18',
    payload: { patch: { pri: 1 } }, expectedVersion: 2, dryRun: false,
  })
  // 单条写的环境失败按"条目失败"如实汇报（这样批量写里其他条目仍可继续）
  assert.equal(result.results[0].ok, false)
  assert.equal(result.results[0].errorCode, 'UNSUPPORTED')
  assert.equal(fake.callsTo('PUT /tasks/18').length, 0, '拿不到当前状态就绝不能写')
})

/* ─────────────── 回读失败 ≠ 写入失败 ─────────────── */

test('回读失败时如实报"未确认"，绝不报成"写入失败"，也不打勾', async () => {
  const world = makeWorld()
  let detailCalls = 0
  world.routes['GET /tasks/18'] = () => {
    detailCalls += 1
    // 第 1 次是并发前置读（成功）；之后的回读返回空 —— 模拟回读形状不可用
    return detailCalls === 1
      ? { json: { id: 18, name: 't', status: 'doing', pri: 3, version: 2 } }
      : { json: null }
  }
  const { service, fake } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false,
  })

  assert.equal(fake.callsTo('PUT /tasks/18').length, 1, '写入必须已经真的发生')
  const entry = result.results[0]
  assert.equal(entry.ok, true, '写入请求被禅道接受 → ok 为 true')
  assert.equal(entry.verified, false, '但必须标记为**未确认**')
  assert.match(entry.note, /回读校验失败/)
  assert.match(entry.note, /已被禅道接受/)

  const text = renderWriteResult({ actionLabel: '修改任务', results: result.results })
  assert.match(text, /未回读确认 1 项/)
  assert.match(text, /请到禅网上复核/)
  assert.doesNotMatch(text, /✓ #18/, '未确认的项不能打勾')
  assert.match(text, /\? #18/, '应用问号标记未确认')
})

/* ─────────────── 删除的校验必须验证"意图"，不是比对载荷 ─────────────── */

test('删除（软删除）：回读看到 deleted=true 才算已验证（实测：真实禅道就是软删除）', async () => {
  const world = makeWorld()
  let calls = 0
  world.routes['DELETE /tasks/18'] = () => ({ json: { message: 'success' } })
  world.routes['GET /tasks/18'] = () => {
    calls += 1
    // 第 1 次是写前的前置读（对象还在）；之后是回读 —— 软删除后详情仍可读但带 deleted
    return calls === 1
      ? { json: rawTask({ id: 18, execution: 13, status: 'doing' }) }
      : { json: { ...rawTask({ id: 18, execution: 13, status: 'doing' }), deleted: true } }
  }
  const { service } = makeService(world)
  const result = await service.write({ action: 'delete', entity: 'task', id: '18', reason: '误建', dryRun: false })
  const entry = result.results[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.verified, true, 'deleted=true 必须判为已验证')
  assert.match(entry.note, /软删除/)
})

test('删除（硬删除）：回读 404 是**成功信号**，不能报成"回读校验失败"', async () => {
  const world = makeWorld()
  let calls = 0
  world.routes['DELETE /tasks/18'] = () => ({ json: { message: 'success' } })
  world.routes['GET /tasks/18'] = () => {
    calls += 1
    if (calls === 1) return { json: rawTask({ id: 18, execution: 13, status: 'doing' }) }
    return { status: 404, json: { error: 'not found' } }
  }
  const { service } = makeService(world)
  const result = await service.write({ action: 'delete', entity: 'task', id: '18', reason: '误建', dryRun: false })
  const entry = result.results[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.verified, true, '对象已经不可读 = 删除成功，必须算已验证')
  assert.match(entry.note, /404|不可读/)
  assert.doesNotMatch(entry.note, /回读校验失败/)
})

test('删除**没生效**时必须如实说"可能没有生效"，不能谎报成功', async () => {
  const world = makeWorld()
  world.routes['DELETE /tasks/18'] = () => ({ json: { message: 'success' } })
  // 回读照旧返回一个正常的、未被标记删除的对象
  world.routes['GET /tasks/18'] = () => ({ json: rawTask({ id: 18, execution: 13, status: 'doing' }) })
  const { service } = makeService(world)
  const result = await service.write({ action: 'delete', entity: 'task', id: '18', reason: '误建', dryRun: false })
  const entry = result.results[0]
  assert.equal(entry.ok, true, 'HTTP 接受仍算 ok')
  assert.equal(entry.verified, false, '但对象还在 = 未验证')
  assert.match(entry.note, /可能没有生效/)
})

/* ─────────────── 备注：形状是推断出来的，效果无法确认就不能声称成功 ─────────────── */

test('comment：HTTP 被接受也**不能**声称已验证（实测该形状不产生动作记录）', async () => {
  const world = makeWorld()
  world.routes['PUT /tasks/18'] = () => ({ json: { id: 18 } })
  world.routes['GET /tasks/18'] = () => ({ json: rawTask({ id: 18, execution: 13, status: 'doing' }) })
  // comment 是未校准形状 → 默认被 allowUnverifiedWrites 闸门拦住，这里显式打开
  const { service } = makeService(world, { config: { allowUnverifiedWrites: true, cacheTtlSeconds: 0 } })
  const result = await service.write({ action: 'comment', entity: 'task', id: '18', payload: { comment: '一条备注' }, dryRun: false })
  const entry = result.results[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.verified, false, '备注效果无法确认 → 不能声称已验证')
  assert.match(entry.note, /无法确认/)
  const text = renderWriteResult({ actionLabel: '添加备注', results: result.results })
  assert.match(text, /没有得到确认/)
})

test('comment：闸门默认关闭时**抛错且发不出请求**（未校准形状不该盲打）', async () => {
  const world = makeWorld()
  world.routes['PUT /tasks/18'] = () => ({ json: { id: 18 } })
  const { service, fake } = makeService(world, { config: { cacheTtlSeconds: 0 } })
  // 闸门错误是"调用方错误"，按设计**抛出**（让模型看到结构化错误并改正），不是条目失败
  await assert.rejects(
    service.write({ action: 'comment', entity: 'task', id: '18', payload: { comment: 'x' }, dryRun: false }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.hint, /allowUnverifiedWrites/)
      return true
    },
  )
  assert.equal(fake.callsTo('PUT /tasks/18').length, 0, '被闸门拦住时绝不能发请求')
})

test('正常回读的写入必须标记为已确认（verified true），并打勾', async () => {
  const world = makeWorld()
  world.routes['GET /tasks/18'] = () => ({ json: { id: 18, name: 't', status: 'doing', pri: 1, version: 2 } })
  const { service } = makeService(world)
  const result = await service.write({
    action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false,
  })
  assert.equal(result.results[0].verified, true)
  const text = renderWriteResult({ actionLabel: '修改任务', results: result.results })
  assert.match(text, /✓ #18/)
  assert.doesNotMatch(text, /未回读确认/)
})

/* ─────────────── 「我的」身份匹配：不能匹配到别人，也不能静默给 0 条 ─────────────── */

test('my：身份匹配必须**精确** —— 李四 不能命中 李四四（子串匹配会给出别人的待办）', async () => {
  const world = makeWorld()
  world.routes['GET /user'] = () => ({ json: { id: 1, account: 'lisi', realname: '李四' } })
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [
      rawTask({ id: 18, execution: 13, assignedTo: { id: 1, account: 'lisi', realname: '李四' } }),
      rawTask({ id: 19, execution: 13, assignedTo: { id: 2, account: 'lisi4', realname: '李四四' } }),
    ], { total: 2 }),
  })
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  const result = await service.my({ include: ['task'] })
  const ids = result.groups.flatMap((group) => group.items.map((item) => item.ref.id))
  assert.deepEqual(ids, ['18'], '只能拿到自己的那一条')
  assert.equal(result.user, '李四')
  assert.ok(result.matchedBy.includes('李四'))
  assert.ok(result.notes.some((note) => note.includes('精确标识匹配')), '必须说明按什么匹配的')
})

test('my：realname 缺失时用 account 匹配（title 会退化成 #id，不能拿它当标识）', async () => {
  const world = makeWorld()
  world.routes['GET /user'] = () => ({ json: { id: 1, account: 'admin' } })
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [
      rawTask({ id: 18, execution: 13, assignedTo: { id: 1, account: 'admin' } }),
      rawTask({ id: 19, execution: 13, assignedTo: { id: 2, account: 'dev' } }),
    ], { total: 2 }),
  })
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  const result = await service.my({ include: ['task'] })
  const ids = result.groups.flatMap((group) => group.items.map((item) => item.ref.id))
  assert.deepEqual(ids, ['18'])
  assert.ok(!result.matchedBy.some((needle) => /^#\d+$/.test(needle)), '绝不能把 #id 当标识')
  assert.ok(result.matchedBy.includes('admin'))
})

test('my：完全拿不到可识别身份时报 AMBIGUOUS，而不是给一份"0 条"', async () => {
  const world = makeWorld()
  world.routes['GET /user'] = () => ({ json: {} })
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  await assert.rejects(service.my({ include: ['task'] }), (error) => {
    assert.equal(error.code, 'AMBIGUOUS')
    assert.match(error.message, /可识别身份/)
    return true
  })
})

test('my：opened 范围按创建人精确匹配', async () => {
  const world = makeWorld()
  world.routes['GET /user'] = () => ({ json: { id: 1, account: 'admin', realname: '管理员' } })
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [
      rawTask({ id: 18, execution: 13, openedBy: { id: 1, account: 'admin', realname: '管理员' } }),
      rawTask({ id: 19, execution: 13, openedBy: { id: 2, account: 'dev', realname: '开发' } }),
    ], { total: 2 }),
  })
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  const result = await service.my({ include: ['task'], scope: 'opened' })
  const ids = result.groups.flatMap((group) => group.items.map((item) => item.ref.id))
  assert.deepEqual(ids, ['18'])
  assert.ok(result.notes.some((note) => note.includes('创建人')))
})

test('query：filters.assignee 传数组时明确拒绝（否则会被拼成逗号串静默匹配不到）', async () => {
  const world = makeWorld()
  const { service } = makeService(world, { cacheTtlSeconds: 0 })
  await assert.rejects(
    service.query({ entity: 'task', scope: { execution: EXECUTION }, filters: { assignee: ['a', 'b'] } }),
    (error) => {
      assert.equal(error.code, 'VALIDATION')
      assert.match(error.message, /只接受字符串/)
      return true
    },
  )
})

test('includeRawPayload：默认关闭时不附带原始载荷', async () => {
  const world = makeWorld()
  const { service } = makeService(world)
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  assert.equal(result.items[0].raw, undefined)
})

test('includeRawPayload：打开后查询给首条附原始载荷，且**秘密字段被脱敏**', async () => {
  const world = makeWorld()
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [
      rawTask({ id: 18, execution: 13, status: 'doing', token: 'super-secret', password: 'pw' }),
      rawTask({ id: 19, execution: 13 }),
    ]),
  })
  const { service } = makeService(world, { config: { includeRawPayload: true, cacheTtlSeconds: 0 } })
  const result = await service.query({ entity: 'task', scope: { execution: EXECUTION } })
  assert.ok(result.items[0].raw, '首条应带原始载荷')
  assert.equal(result.items[0].raw.status, 'doing')
  assert.equal(result.items[0].raw.token, '***', '原始载荷也要脱敏')
  assert.equal(result.items[0].raw.password, '***')
  assert.equal(result.items[1].raw, undefined, '只给首条，避免把结果撑爆')
  assert.doesNotMatch(JSON.stringify(result.items), /super-secret/)
})

test('includeRawPayload：详情也附带，并能被渲染出来', async () => {
  const world = makeWorld()
  const { service } = makeService(world, { config: { includeRawPayload: true, cacheTtlSeconds: 0 } })
  const result = await service.get({ entity: 'task', id: '18' })
  assert.ok(result.item.raw, '详情应带原始载荷')
  const text = renderItem(result.item, { entityLabel: '任务' })
  assert.match(text, /原始载荷/)
  assert.match(text, /已脱敏/)
})

/* ─────────────── 写后校验的**诚实性**（log_effort 假成功事故的回归）─────────────── */

test('写后校验：服务器"接受了但没改"必须报 verified=false（不能算成功）', async () => {
  // 真机事故（2026-10-08）：`log_effort` 走 v1 的 /estimate，服务器**完全忽略**了它
  // （聚合值没变、zt_effort 没有新行），但插件报了 `ok=true verified=true diff=[]` ——
  // 原因是 consumed/left 不在可比对的字段表里，于是"一个字段都没比对"却被当成通过。
  const routes = {
    // 服务器接受请求，但**什么都不改**
    'POST /tasks/18/estimate': () => ({ json: { id: 18 } }),
    'GET /tasks/18': () => ({ json: rawTask({ id: 18, execution: 13, status: 'doing', consumed: '1.5', left: '2', name: '工时不动' }) }),
  }
  const { service } = makeService({ routes }, { config: { allowUnverifiedWrites: true, writePolicy: 'trusted' } })

  const result = await service.write({
    action: 'log_effort',
    entity: 'task',
    id: '18',
    payload: { consumed: 9, left: 3, date: '2026-10-08' },
    dryRun: false,
  })
  const item = result.results?.[0] ?? result
  assert.equal(item.ok, true, '请求确实被服务器接受了')
  assert.equal(item.verified, false, '服务器没改数据就不能说"已验证"')
  assert.equal(item.checkedFields, 2, 'consumed/left 必须真的被比对过（两个字段）')
  assert.match(item.diff.join(' '), /consumed 期望 9 实际 1\.5/)
  assert.match(item.diff.join(' '), /left 期望 3 实际 2/)
})

test('写后校验：真的生效的写入仍然报 verified=true（上一条不是把校验关掉）', async () => {
  const routes = {
    'PUT /tasks/18': ({ body }) => ({ json: { id: 18, pri: body.pri } }),
    // 回读时返回**改后**的值
    'GET /tasks/18': () => ({ json: rawTask({ id: 18, execution: 13, status: 'doing', pri: 1, name: '改过了' }) }),
  }
  const { service } = makeService({ routes }, { config: { allowUnverifiedWrites: true, writePolicy: 'trusted' } })
  const result = await service.write({ action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false })
  const item = result.results?.[0] ?? result
  assert.equal(item.verified, true)
  assert.equal(item.checkedFields, 1)
})

/* ─────────────── 严格 v2-only 相关的两处校验（真机对齐后补的离线回归）─────────────── */

test('状态流转校验：finish 的载荷字段不可比对时，改按**结果状态**校验', async () => {
  // finish 的载荷是 currentConsumed/finishedDate —— 都不在可比对字段表里。
  // 只按字段比对会得到 checked=0（"无法确认"）；正确做法是比对结果状态：done。
  // 注意 v1 的 finish 是 **POST**（v2 注册表里是 PUT，由 v2 方言覆盖）。
  let phase = 'before'
  const routes = {
    'GET /tasks/18': () => ({ json: rawTask({ id: 18, execution: 13, status: phase === 'before' ? 'doing' : 'done', name: 'x', consumed: '0', left: '2' }) }),
    'POST /tasks/18/finish': () => { phase = 'after'; return { json: { status: 'success' } } },
  }
  const { service } = makeService({ routes }, { config: { allowUnverifiedWrites: true, writePolicy: 'trusted' } })
  const result = await service.write({ action: 'finish', entity: 'task', id: '18', payload: { currentConsumed: 2, finishedDate: '2026-10-08 18:00:00', realStarted: '2026-10-08 09:00:00' }, dryRun: false })
  const item = result.results?.[0] ?? result
  assert.equal(item.ok, true, JSON.stringify(item).slice(0, 200))
  assert.equal(item.verified, true, '状态真的变成 done 就该算验证通过')
  assert.equal(item.checkedFields, 1, '按结果状态校验：算一项')
})

test('状态流转校验：状态**没变**时必须报 verified=false 并给出状态差异', async () => {
  let phase = 'before'
  const routes = {
    // 服务器接受请求，但状态始终是 doing
    'GET /tasks/18': () => ({ json: rawTask({ id: 18, execution: 13, status: 'doing', name: '没变', consumed: '0', left: '2' }) }),
    'POST /tasks/18/finish': () => { phase = 'after'; return { json: { status: 'success' } } },
  }
  const { service } = makeService({ routes }, { config: { allowUnverifiedWrites: true, writePolicy: 'trusted' } })
  const result = await service.write({ action: 'finish', entity: 'task', id: '18', payload: { currentConsumed: 2, finishedDate: '2026-10-08 18:00:00', realStarted: '2026-10-08 09:00:00' }, dryRun: false })
  const item = result.results?.[0] ?? result
  assert.equal(item.verified, false)
  assert.match(item.diff.join(' '), /status 期望 done 实际 doing/)
})

test('删除校验：v2 的"对象不存在"（HTTP 200 + status=fail）必须识别成 NOT_FOUND —— 删除成功信号', async () => {
  // 真机实测：v2 删除后回读得到 200 {"status":"fail","message":"Task does not exist."}。
  // 若一律当 VALIDATION，删除会被报成"回读校验失败"而不是"已删除"。
  // 注意：**预读**（写之前读一次当前对象）必须成功，删除后的回读才失败 —— 所以要一个有状态的夹具。
  let deleted = false
  const routes = {
    'DELETE /tasks/18': () => { deleted = true; return { json: { status: 'success', message: '保存成功' } } },
    'GET /tasks/18': () => (deleted
      ? { json: { status: 'fail', message: 'Task does not exist.' } }
      : { json: rawTask({ id: 18, execution: 13, status: 'doing', name: '待删', consumed: '0', left: '2' }) }),
  }
  const fake = createFakeTransport(routes, { stripPrefix: '/api.php/v2' })
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0, dialect: 'rest-v2', allowUnverifiedWrites: true, writePolicy: 'trusted' }),
    getToken: async () => 'test-token',
    logger: () => {},
  })
  const result = await service.write({ action: 'delete', entity: 'task', id: '18', dryRun: false })
  const item = result.results?.[0] ?? result
  assert.equal(item.ok, true, JSON.stringify(item).slice(0, 220))
  assert.equal(item.verified, true, '回读报"不存在" = 删除成功，应报 verified')
  assert.match(String(item.note ?? ''), /已删除/)
})
