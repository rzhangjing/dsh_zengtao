/**
 * 路由守卫：把"本插件发出的路径到底存不存在"从人工核对变成机械检查。
 *
 * 依据是禅道自己的**显式路由表快照**（`test/fixtures/apiv1-routes.js`，抄自
 * `app/zentao/config/apiv1.php`）。这一层是必要的：我在校准过程中先后写错过三处路径
 * （`/plans/:id`、`/tasks/:id/efforts`、`/tasks/:id/recordestimate`），而**它们的症状
 * 都是 404 兜底**，单看某一次调用是分辨不出"路径错"还是"记录不存在"的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRestV1Dialect } from '../src/transport/dialects/rest-v1.js'
import { ENTITY_KEYS, ENTERPRISE_ENTITY_KEYS } from '../src/domain/model.js'
import { ZENTAO_V1_ROUTES } from './fixtures/apiv1-routes.js'

const dialect = createRestV1Dialect()

/** 每个实体取列表需要的范围（缺范围的实体如 testtask 用项目）。 */
const SCOPES = {
  execution: { project: '1' },
  story: { product: '1' },
  task: { execution: '1' },
  bug: { product: '1' },
  plan: { product: '1' },
  release: { product: '1' },
  build: { execution: '1' },
  testcase: { product: '1' },
  testtask: { project: '1' },
}

const matchers = ZENTAO_V1_ROUTES.map((pattern) =>
  new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+').replace(/\//g, '\\/')}$`))
const known = (path) => matchers.some((re) => re.test(path))

test('守卫本身不是空转：快照里有真实路由，且历史错误路径必须被判为"不存在"', () => {
  assert.ok(ZENTAO_V1_ROUTES.length > 100, '路由快照条数异常，快照可能没抄全')
  assert.equal(known('/products/1/bugs'), true)
  assert.equal(known('/tasks/1/estimate'), true)
  // 这三条是我真实写错过的路径 —— 守卫必须把它们判为不存在
  assert.equal(known('/plans/1'), false, '/plans/:id 不存在（详情是 /productplans/:id）')
  assert.equal(known('/tasks/1/efforts'), false, '/tasks/:id/efforts 不存在（是 /estimate）')
  assert.equal(known('/tasks/1/recordestimate'), false, '/tasks/:id/recordestimate 不存在（是 /estimate）')
  assert.equal(known('/zzz/1'), false)
})

test('本插件可能发出的**每一条读路径**都必须在禅道权威路由表里', () => {
  const collected = []
  for (const key of [...ENTITY_KEYS, ...ENTERPRISE_ENTITY_KEYS]) {
    const scope = SCOPES[key] ?? {}
    try {
      collected.push([`list ${key}`, dialect.listSpec(key, { scope, page: 1, limit: 5 }).path])
    } catch { /* 需要其它范围的实体（或本版本不可用）跳过 */ }
    try {
      collected.push([`detail ${key}`, dialect.detailSpec(key, '1').path])
    } catch { /* 同上 */ }
  }
  collected.push(['me', dialect.meSpec().path])
  collected.push(['tokens', '/tokens'])

  assert.ok(collected.length >= 25, `收集到的读路径太少（${collected.length}），守卫可能失效`)
  const missing = collected.filter(([, path]) => !known(path))
  assert.deepEqual(missing, [], `以下读路径不在禅道路由表里：${JSON.stringify(missing)}`)
})

test('本插件可能发出的**每一条写路径**都必须在禅道权威路由表里', () => {
  const cases = [
    ['create', 'task', { execution: '1', name: 't' }],
    ['create', 'bug', { product: '1', title: 'b' }],
    ['create', 'story', { title: 's', spec: '描述' }],
    ['update', 'task', { patch: { name: 't' } }],
    ['update', 'bug', { patch: { title: 'b' } }],
    ['update', 'story', { patch: { title: 's' } }],
    ['start', 'task', { left: 1 }],
    ['finish', 'task', { currentConsumed: 1, finishedDate: '2026-01-01 10:00:00' }],
    ['assign', 'task', { assignedTo: 'admin', left: 1 }],
    ['assign', 'bug', { assignedTo: 'admin' }],
    ['assign', 'story', { assignedTo: 'admin' }],
    ['close', 'task', { reason: 'x' }],
    ['close', 'bug', { reason: 'x' }],
    ['close', 'story', { reason: 'x', closedReason: 'willnotdo' }],
    ['resolve', 'bug', { resolution: 'fixed', resolvedBuild: 'trunk' }],
    ['delete', 'task', {}],
    ['delete', 'bug', {}],
    ['delete', 'story', {}],
    ['log_effort', 'task', { consumed: 1 }],
    ['log_effort', 'bug', { consumed: 1 }],
    ['log_effort', 'story', { consumed: 1 }],
    ['comment', 'task', { comment: 'x' }],
  ]
  const collected = []
  for (const [action, entity, payload] of cases) {
    let spec
    try {
      spec = dialect.writeSpec(action, { entity, id: '7', payload })
    } catch {
      continue // 本地校验/不支持的组合：不发请求，自然也不需要路径
    }
    collected.push([`${action} ${entity}`, spec.path])
  }
  assert.ok(collected.length >= 18, `收集到的写路径太少（${collected.length}），守卫可能失效`)
  const missing = collected.filter(([, path]) => !known(path))
  assert.deepEqual(missing, [], `以下写路径不在禅道路由表里：${JSON.stringify(missing)}`)
})
