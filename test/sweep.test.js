/**
 * 只读端点扫描（`/zentao sweep`）与"未校准写形状默认闸门"的离线测试。
 *
 * 这两件事直接服务于 §7.6 校准：
 *   · sweep 是**取证工具** —— 它必须只发 GET，且必须把字段名与状态样本原样带出来，
 *     否则拿到真实实例也标定不了归一化表；
 *   · 闸门是**安全默认** —— 手册没给 REST 形状的那几个写动作，在真实数据上绝不能盲打。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createService } from '../src/service.js'
import { KeyedQueue } from '../src/domain/locks.js'
import { renderSweep } from '../src/domain/render.js'
import { createFakeTransport, createMemoryStore, fakeConfig, listEnvelope, rawTask } from './helpers.js'
import { registerCommands } from '../src/commands.js'

/** 一个够用的假禅道：产品/项目/执行/任务/Bug/用户 都能列。 */
function makeSweepWorld (overrides = {}) {
  const routes = {
    'GET /products': () => ({ json: listEnvelope('products', [{ id: 7, name: '产品A', code: '', status: 'normal' }]) }),
    'GET /projects': () => ({ json: listEnvelope('projects', [{ id: 12, name: '项目A', status: 'doing' }]) }),
    'GET /projects/12/executions': () => ({ json: listEnvelope('executions', [{ id: 13, name: '迭代1', status: 'doing' }]) }),
    'GET /executions/13/tasks': () => ({ json: listEnvelope('tasks', [rawTask({ id: 18, execution: 13, status: 'done', pri: 3 })]) }),
    'GET /products/7/bugs': () => ({ json: listEnvelope('bugs', [{ id: 501, title: '白屏', status: 'active', pri: 1, assignedTo: { id: 1, account: 'admin', realname: '张三' } }]) }),
    'GET /users': () => ({ json: listEnvelope('users', [{ id: 1, account: 'admin', realname: '管理员' }]) }),
    'GET /products/7/stories': () => ({ json: listEnvelope('stories', [{ id: 31, title: '需求A', status: 'active', pri: 2 }]) }),
    'GET /products/7/plans': () => ({ json: listEnvelope('plans', [{ id: 41, title: '计划A', status: 'wait' }]) }),
    'GET /products/7/testcases': () => ({ json: listEnvelope('testcases', [{ id: 51, title: '用例A', status: 'wait' }]) }),
    'GET /testtasks': () => ({ json: listEnvelope('testtasks', [{ id: 61, title: '测试单A', status: 'wait' }]) }),
    'GET /projects/12/builds': () => ({ json: listEnvelope('builds', [{ id: 71, name: '版本A', status: 'normal' }]) }),
    'GET /products/7/releases': () => ({ json: listEnvelope('releases', [{ id: 81, name: '发布A' }]) }),
    // 刻意的两种失败：一个 403、一个 404
    'GET /feedbacks': () => ({ status: 403, json: { error: 'forbidden' } }),
    'GET /tickets': () => ({ status: 404, json: { error: 'not found' } }),
    ...overrides,
  }
  return { routes }
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

/* ───────────────────── sweep：取证工具 ───────────────────── */

test('sweep：只发 GET，绝不发写请求（这是它敢对着生产库跑的前提）', async () => {
  const world = makeSweepWorld()
  const { service, fake } = makeService(world)
  await service.sweep()
  assert.ok(fake.calls.length > 0, '应该真的发了请求')
  for (const call of fake.calls) {
    assert.equal(call.method, 'GET', `扫描发现了非 GET 请求：${call.method} ${call.key}`)
  }
})

test('sweep：先发现产品/项目/执行 id，再用它们探有范围的实体（路径必须正确）', async () => {
  const world = makeSweepWorld()
  const { service, fake } = makeService(world)
  const result = await service.sweep()

  assert.equal(result.readOnly, true)
  assert.equal(result.discovered.productId, '7')
  assert.equal(result.discovered.projectId, '12')
  assert.equal(result.discovered.executionId, '13')

  const byEntity = Object.fromEntries(result.probes.map((probe) => [probe.entity, probe]))
  assert.equal(byEntity.task.path, '/api.php/v1/executions/13/tasks', '任务必须挂在发现到的执行下；路径必须含 API 前缀')
  assert.equal(byEntity.bug.path, '/api.php/v1/products/7/bugs', 'Bug 必须挂在发现到的产品下')
  assert.equal(byEntity.story.path, '/api.php/v1/products/7/stories')
  assert.equal(byEntity.execution.path, '/api.php/v1/projects/12/executions')
  assert.equal(byEntity.user.path, '/api.php/v1/users')
  assert.equal(fake.callsTo('GET /executions/13/tasks').length, 1)
})

test('sweep：必须带回字段名与状态样本（否则拿到真实实例也标定不了归一化表）', async () => {
  const world = makeSweepWorld()
  const { service } = makeService(world)
  const result = await service.sweep({ include: ['task'] })
  const task = result.probes.find((probe) => probe.entity === 'task')
  assert.equal(task.ok, true)
  assert.equal(task.itemCount, 1)
  assert.ok(task.fieldNames.includes('name'), `字段名应含禅道原名 name：${task.fieldNames}`)
  assert.ok(task.fieldNames.includes('assignedTo'))
  assert.equal(task.statusSample, 'done', '状态样本必须原样带回（用于标定映射表）')
  assert.equal(task.priSample, 3)
  assert.equal(task.assignedSample, 'object', '指派人字段是对象还是字符串必须能看出来')
  assert.deepEqual(task.meta, { page: 1, total: 1, limit: 50 })
})

test('sweep：单个实体失败不中断整轮，且如实记录状态与错误头', async () => {
  const world = makeSweepWorld()
  const { service } = makeService(world)
  const result = await service.sweep()
  const feedback = result.probes.find((probe) => probe.entity === 'feedback')
  const ticket = result.probes.find((probe) => probe.entity === 'ticket')
  assert.equal(feedback.ok, false)
  assert.equal(feedback.status, 403)
  assert.equal(ticket.status, 404)
  // 其余实体仍然被探到
  assert.ok(result.probes.some((probe) => probe.entity === 'task' && probe.ok === true))
})

test('sweep：HTML 响应被标出来（"打到了网页而不是接口"）', async () => {
  const world = makeSweepWorld({ 'GET /products': { __html: true, status: 200 } })
  const { service } = makeService(world)
  const result = await service.sweep({ include: ['product'] })
  const product = result.probes.find((probe) => probe.entity === 'product')
  assert.equal(product.html, true)
  assert.equal(product.ok, true)
})

test('sweep：没有范围 id 时**跳过**并说明原因，而不是拼出坏 URL', async () => {
  const world = makeSweepWorld({
    'GET /products': () => ({ json: listEnvelope('products', []) }),
    'GET /projects': () => ({ json: listEnvelope('projects', []) }),
  })
  const { service, fake } = makeService(world)
  const result = await service.sweep()
  assert.ok(result.skipped.some((skip) => skip.entity === 'task'))
  // 关键：跳过的实体不得产生任何"undefined"路径请求
  for (const call of fake.calls) {
    assert.doesNotMatch(call.pathname, /undefined/, `出现了坏路径：${call.pathname}`)
  }
})

test('sweep：include 只限制"其余实体"，发现 id 所需的产品/项目/执行始终会探', async () => {
  const world = makeSweepWorld()
  const { service, fake } = makeService(world)
  const result = await service.sweep({ include: ['bug'] })
  const entities = new Set(result.probes.map((probe) => probe.entity))
  assert.ok(entities.has('bug'))
  assert.ok(!entities.has('user'), '未点名的实体不应被扫')
  assert.ok(!entities.has('ticket'), '企业版附加实体只在全量扫描时才探')
  // 发现阶段是必需的：否则 bug 的路径都拼不出来
  assert.ok(entities.has('product'), '发现阶段必须探产品')
  assert.ok(result.discovered.productId, '必须发现到产品 id')
  assert.match(result.discoveryNote, /始终会被探测/)
  assert.equal(fake.callsTo('GET /products/7/bugs').length, 1)
})

test('renderSweep：报告必须包含判定、字段名、状态样本、信封键名与下一步', () => {
  const text = renderSweep({
    siteLabel: '测试禅道',
    dialectLabel: '禅道 REST v1',
    dialectId: 'rest-v1',
    baseURL: 'https://zt.example.com',
    probedAt: '2026-03-10T00:00:00.000Z',
    discovered: { productId: '7' },
    probes: [
      {
        entity: 'task', method: 'GET', path: '/executions/13/tasks', ok: true, status: 200,
        itemCount: 1, meta: { page: 1, total: 1, limit: 50 },
        envelopeKeys: ['page', 'total', 'limit', 'tasks'],
        fieldNames: ['id', 'name', 'status', 'assignedTo'], idSample: 18, statusSample: 'done', priSample: 3,
      },
      { entity: 'ticket', ok: false, status: 404, method: 'GET', path: '/tickets' },
    ],
    skipped: [{ entity: 'build', reason: '没有范围 id' }],
  })
  assert.match(text, /只读保证/)
  assert.match(text, /可用/)
  assert.match(text, /不存在\(404\)/)
  assert.match(text, /name, status, assignedTo/)
  assert.match(text, /status="done"/)
  assert.match(text, /page, total, limit, tasks/)
  assert.match(text, /跳过/)
  assert.match(text, /回贴给插件维护者/)
})

/* ─────────────── 未校准写形状的默认闸门 ─────────────── */

test('闸门：未校准的写动作在默认配置下被阻止，且不发任何请求', async () => {
  // 用 comment（实测反证后仍是未确认形状）来测闸门；resolve×bug 已实测确认，不再被拦
  const world = makeSweepWorld({ 'PUT /bugs/501': () => ({ json: { id: 501 } }) })
  const { service, fake } = makeService(world)
  await assert.rejects(
    service.write({ action: 'comment', entity: 'bug', id: '501', payload: { comment: 'hi' }, dryRun: false }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /尚未经真机校准/)
      assert.match(error.hint, /allowUnverifiedWrites/)
      assert.match(error.hint, /\/zentao sweep/)
      return true
    },
  )
  assert.equal(fake.callsTo('PUT /bugs/501').length, 0, '被阻止时绝不能真的发出去')
})

test('闸门：dryRun 仍然允许（计划本身就是要看的）', async () => {
  const world = makeSweepWorld()
  const { service } = makeService(world)
  const plan = await service.write({ action: 'comment', entity: 'bug', id: '501', payload: { comment: 'hi' }, dryRun: true })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.verified, false)
  assert.equal(plan.steps[0].path, '/api.php/v1/bugs/501')
  assert.ok(plan.notes.some((note) => typeof note === 'string' && note.length > 0), '应带上"未校准"的说明')
})

test('闸门：用户显式打开后，未校准动作才会真正执行', async () => {
  const world = makeSweepWorld({
    'PUT /bugs/501': () => ({ json: { id: 501 } }),
    'GET /bugs/501': () => ({ json: { id: 501, title: '白屏', status: 'resolved', version: 2 } }),
  })
  const { service, fake } = makeService(world, { allowUnverifiedWrites: true })
  const result = await service.write({
    action: 'comment', entity: 'bug', id: '501', payload: { comment: 'hi' }, dryRun: false,
  })
  assert.equal(result.results[0].ok, true)
  assert.equal(fake.callsTo('PUT /bugs/501').length, 1)
})

test('闸门：**已实测确认**的动作（resolve×bug）关闭闸门时也照常执行', async () => {
  const world = makeSweepWorld({
    'POST /bugs/501/resolve': () => ({ json: { id: 501, status: 'resolved' } }),
    'GET /bugs/501': () => ({ json: { id: 501, title: '白屏', status: 'resolved' } }),
  })
  const { service, fake } = makeService(world)
  const result = await service.write({
    action: 'resolve', entity: 'bug', id: '501', payload: { resolution: 'fixed', resolvedBuild: 'trunk' }, dryRun: false,
  })
  assert.equal(result.results[0].ok, true)
  assert.equal(fake.callsTo('POST /bugs/501/resolve').length, 1)
})

test('闸门：**已校准**的动作不受该开关影响（关闭时也照常执行）', async () => {
  const world = makeSweepWorld({
    'PUT /tasks/18': ({ body }) => ({ json: { id: 18, name: 't', status: 'doing', pri: body.pri ?? 3, version: 2 } }),
    'GET /tasks/18': () => ({ json: { id: 18, name: 't', status: 'doing', pri: 1, version: 2 } }),
  })
  const { service, fake } = makeService(world)
  const result = await service.write({ action: 'update', entity: 'task', id: '18', payload: { patch: { pri: 1 } }, dryRun: false })
  assert.equal(result.results[0].ok, true)
  assert.equal(fake.callsTo('PUT /tasks/18').length, 1)
})

/* ─────────────── 命令层接线 ─────────────── */

test('/zentao sweep：命令能跑通并返回报告；/zentao help 列出该子命令', async () => {
  const world = makeSweepWorld()
  const { service } = makeService(world)
  const registered = []
  const commandsService = { register: (command) => { registered.push(command); return () => {} } }
  const ctx = {
    commands: commandsService,
    // 真实 Cordis 里两种取法都成立；命令层用的是 ctx.get('commands')
    get: (name) => (name === 'commands' ? commandsService : undefined),
  }
  registerCommands(ctx, service, () => fakeConfig({ cacheTtlSeconds: 0 }), { get: () => undefined })
  assert.equal(registered.length, 1, '必须注册 /zentao 命令')
  const command = registered[0]

  const sweep = await command.handler({ rawInput: 'sweep task' })
  assert.equal(sweep.kind, 'success')
  assert.match(sweep.text, /只读端点扫描/)
  assert.match(sweep.text, /\/api\.php\/v1\/executions\/13\/tasks/)

  const help = await command.handler({ rawInput: 'help' })
  assert.match(help.text, /\/zentao sweep/)
})
