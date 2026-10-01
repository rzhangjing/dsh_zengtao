/**
 * 看板（board）与"可见范围缓存"的离线测试。
 *
 * 这里钉住一个**真实缺陷**：项目范围的看板原先把"执行"当成"任务"上报
 * （默认 include 里就有 tasks，所以每次都会误报计数）。现在三组各自独立，
 * 且任务通过"跨执行有界扫描"获得，覆盖不全时明确写在 notes 里。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createService, SCAN_BOUNDS } from '../src/service.js'
import { KeyedQueue } from '../src/domain/locks.js'
import { renderBoard } from '../src/domain/render.js'
import { createFakeTransport, createMemoryStore, fakeConfig, listEnvelope, rawTask } from './helpers.js'

function makeBoardWorld ({ executions = 2 } = {}) {
  const executionList = Array.from({ length: executions }, (_, i) => ({
    id: 13 + i, project: 12, product: 1, name: `迭代${i + 1}`, status: 'doing',
  }))
  const routes = {
    'GET /products': () => ({ json: listEnvelope('products', [{ id: 1, name: '产品A', status: 'normal' }]) }),
    'GET /projects': () => ({ json: listEnvelope('projects', [{ id: 12, name: '项目A', status: 'doing' }]) }),
    'GET /projects/12/executions': () => ({
      json: listEnvelope('executions', executionList, { limit: 50, total: executionList.length }),
    }),
    'GET /projects/12/stories': () => ({ json: listEnvelope('stories', [{ id: 31, title: '项目需求', status: 'active', pri: 2 }]) }),
    'GET /products/1/stories': () => ({ json: listEnvelope('stories', [{ id: 32, title: '产品需求', status: 'active', pri: 2 }]) }),
    'GET /executions/13/stories': () => ({ json: listEnvelope('stories', [{ id: 33, title: '迭代需求', status: 'active', pri: 1 }]) }),
    'GET /executions/13/tasks': () => ({ json: listEnvelope('tasks', [rawTask({ id: 18, execution: 13, status: 'doing', pri: 1 })]) }),
    'GET /executions/13': () => ({ json: { id: 13, project: 12, product: 1, name: '迭代1', status: 'doing' } }),
    'GET /products/1/bugs': () => ({ json: listEnvelope('bugs', [{ id: 501, title: '白屏', status: 'active', pri: 1 }]) }),
    'GET /user': () => ({ json: { id: 1, account: 'admin', realname: 'administrator' } }),
  }
  // 每个执行都返回一条任务，用来验证"跨执行有界扫描"
  for (const execution of executionList) {
    routes[`GET /executions/${execution.id}/tasks`] = () => ({
      json: listEnvelope('tasks', [rawTask({ id: 100 + execution.id, execution: execution.id, status: 'doing', pri: 2 })]),
    })
  }
  return { routes, executionList }
}

function makeService (world, config = {}) {
  const fake = createFakeTransport(world.routes)
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0, ...config }),
    getToken: async () => 'test-token',
    logger: () => {},
  })
  return { service, fake }
}

test('board(execution)：需求 + 任务 + Bug（Bug 经该执行的产品取到）', async () => {
  const world = makeBoardWorld()
  const { service } = makeService(world)
  const result = await service.board({ scope: 'execution', id: '13' })
  const labels = result.counts.map((group) => group.label)
  assert.deepEqual(labels, ['需求', '任务', 'Bug'])
  assert.equal(result.counts[0].total, 1)
  assert.equal(result.counts[1].total, 1)
  assert.equal(result.counts[2].total, 1)
})

test('board(execution)：执行没有关联产品时，Bug 组缺席且**说明原因**', async () => {
  const world = makeBoardWorld()
  world.routes['GET /executions/13'] = () => ({ json: { id: 13, project: 12, product: null, name: '迭代1' } })
  const { service } = makeService(world)
  const result = await service.board({ scope: 'execution', id: '13' })
  assert.ok(!result.counts.some((group) => group.label === 'Bug'))
  assert.match(result.notes.join('\n'), /没有关联产品/)
})

test('board(project)：默认三组是需求/执行/任务 —— **不能把执行当成任务**（原缺陷）', async () => {
  const world = makeBoardWorld({ executions: 2 })
  const { service, fake } = makeService(world)
  const result = await service.board({ scope: 'project', id: '12' })

  const labels = result.counts.map((group) => group.label)
  assert.deepEqual(labels, ['需求', '执行（迭代）', '任务'], `项目看板默认分组应为需求/执行/任务：${labels}`)

  const taskGroup = result.counts.find((group) => group.label === '任务')
  const executionGroup = result.counts.find((group) => group.label === '执行（迭代）')
  assert.equal(executionGroup.total, 2, '执行组是执行数')
  assert.equal(taskGroup.total, 2, '任务组是跨执行汇总出来的任务数（每个执行 1 条）')
  // 任务确实是通过各执行的 tasks 端点取的，而不是把执行本身当任务
  assert.equal(fake.callsTo('GET /executions/13/tasks').length, 1)
  assert.equal(fake.callsTo('GET /executions/14/tasks').length, 1)
})

test('board(project)：只有显式点名 bugs 时才解释"Bug 不在项目范围"', async () => {
  const world = makeBoardWorld()
  const { service } = makeService(world)
  const withDefault = await service.board({ scope: 'project', id: '12' })
  assert.ok(!withDefault.notes.some((note) => note.includes('Bug')), '默认不应产生 Bug 说明')
  const withBugs = await service.board({ scope: 'project', id: '12', include: ['bugs'] })
  assert.match(withBugs.notes.join('\n'), /Bug 挂在产品下/)
})

test('board(project)：执行数超过上限时只覆盖前 N 个，并**明确说计数不完整**', async () => {
  const world = makeBoardWorld({ executions: SCAN_BOUNDS.boardExecutionsForTasks + 2 })
  const { service, fake } = makeService(world)
  const result = await service.board({ scope: 'project', id: '12' })
  const taskCalls = fake.calls.filter((call) => /^GET \/executions\/\d+\/tasks$/.test(call.key))
  assert.equal(taskCalls.length, SCAN_BOUNDS.boardExecutionsForTasks, '每个执行只取 1 页，且受上限约束')
  assert.match(result.notes.join('\n'), /不完整/)
  assert.match(result.notes.join('\n'), new RegExp(`前 ${SCAN_BOUNDS.boardExecutionsForTasks}/`))
})

test('board(project)：项目下没有执行时给出提示而不是空看板', async () => {
  const world = makeBoardWorld({ executions: 0 })
  const { service } = makeService(world)
  const result = await service.board({ scope: 'project', id: '12' })
  assert.match(result.notes.join('\n'), /没有执行/)
})

test('board(product)：需求 + Bug；点任务/执行时说明它们不在产品范围内', async () => {
  const world = makeBoardWorld()
  const { service } = makeService(world)
  const result = await service.board({ scope: 'product', id: '1', include: ['stories', 'bugs', 'tasks'] })
  const labels = result.counts.map((group) => group.label)
  assert.deepEqual(labels, ['需求', 'Bug'])
  assert.match(result.notes.join('\n'), /任务与执行挂在项目\/执行下/)
})

test('board：include 生效（只要需求时不会去打任务或 Bug 的请求）', async () => {
  const world = makeBoardWorld()
  const { service, fake } = makeService(world)
  const result = await service.board({ scope: 'execution', id: '13', include: ['stories'] })
  assert.deepEqual(result.counts.map((group) => group.label), ['需求'])
  assert.equal(fake.callsTo('GET /executions/13/tasks').length, 0)
  assert.equal(fake.callsTo('GET /products/1/bugs').length, 0)
})

test('board：非法范围报 VALIDATION', async () => {
  const world = makeBoardWorld()
  const { service } = makeService(world)
  await assert.rejects(service.board({ scope: 'nope', id: '1' }), (error) => {
    assert.equal(error.code, 'VALIDATION')
    return true
  })
})

/* ─────────────── 计数用服务端总数，而不是"我取回了多少" ─────────────── */

test('board：分组计数用**服务端报告的总数**，不是取回的条数；并说明状态分布只基于取回的那批', async () => {
  const world = makeBoardWorld()
  // 执行 13 报告 total=40，但只返回 1 条（模拟"页大小有限"）
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [rawTask({ id: 18, execution: 13, status: 'doing' })], { total: 40, limit: 50 }),
  })
  const { service } = makeService(world)
  const result = await service.board({ scope: 'execution', id: '13', include: ['tasks'] })
  const group = result.counts.find((entry) => entry.label === '任务')
  assert.equal(group.total, 40, '看板计数必须是服务端总数')
  assert.equal(group.byStatusBasis, 1, '同时记下状态分布实际基于几条')
  assert.ok(result.notes.some((note) => note.includes('共 40 条') && note.includes('取回 1 条')),
    '必须说明状态分布只覆盖取回的那批')

  const text = renderBoard({ scopeLabel: 'execution #13', counts: result.counts, blockers: [], topItems: [] })
  assert.match(text, /任务：共 40/)
  assert.match(text, /状态分布基于 1 条/)
})

test('board(project)：跨执行统计任务时累加**各执行报告的总数**', async () => {
  const world = makeBoardWorld({ executions: 2 })
  world.routes['GET /executions/13/tasks'] = () => ({
    json: listEnvelope('tasks', [rawTask({ id: 18, execution: 13 })], { total: 7 }),
  })
  world.routes['GET /executions/14/tasks'] = () => ({
    json: listEnvelope('tasks', [rawTask({ id: 19, execution: 14 })], { total: 5 }),
  })
  const { service } = makeService(world)
  const result = await service.board({ scope: 'project', id: '12' })
  const group = result.counts.find((entry) => entry.label === '任务')
  assert.equal(group.total, 12, '7 + 5，而不是取回的 2')
})

/* ─────────────── 可见范围缓存 ─────────────── */

test('my：可见范围（项目/执行/产品）进缓存，第二次调用不再重走项目树', async () => {
  const world = makeBoardWorld()
  const { service, fake } = makeService(world, { cacheTtlSeconds: 300 })

  await service.my({ include: ['task'] })
  const projectsAfterFirst = fake.callsTo('GET /projects').length
  const executionsAfterFirst = fake.callsTo('GET /projects/12/executions').length
  assert.equal(projectsAfterFirst, 1)

  await service.my({ include: ['task'] })
  assert.equal(fake.callsTo('GET /projects').length, projectsAfterFirst, '第二次不应重走项目列表')
  assert.equal(fake.callsTo('GET /projects/12/executions').length, executionsAfterFirst, '第二次不应重走执行列表')
})

test('my：缓存关闭（cacheTtlSeconds=0）时每次都重走，保证数据新鲜', async () => {
  const world = makeBoardWorld()
  const { service, fake } = makeService(world, { cacheTtlSeconds: 0 })
  await service.my({ include: ['task'] })
  await service.my({ include: ['task'] })
  assert.equal(fake.callsTo('GET /projects').length, 2)
})

test('可见范围缓存与详情缓存分开存放（不互相污染）', async () => {
  const world = makeBoardWorld()
  const fake = createFakeTransport(world.routes)
  const store = createMemoryStore()
  const service = createService({
    transport: fake.transport,
    store,
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 300 }),
    getToken: async () => 't',
    logger: () => {},
  })
  await service.my({ include: ['task'] })
  assert.ok(store._entities.has('scope:executions'), '范围缓存应落在 scope:executions 键上')
  assert.ok(store._entities.has('user:me'), '当前用户缓存应落在 user:me 键上')
})
