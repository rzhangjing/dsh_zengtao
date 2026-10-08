/**
 * REST **v2** 方言测试。
 *
 * 这里的期望值**全部来自真机实测或官方注册表**（不是猜的）：
 *   · 路径来自官方 SDK `zentao-api@0.7.0` 的注册表（`rest-v2.routes.js`，自动生成）；
 *   · 分页参数名 `pageID`/`recPerPage` 与 `pager` 字段（`recTotal`/`recPerPage`/`pageID`…）
 *     来自本机 IPD 5.6 的实测响应；
 *   · `browseType` 默认 `unclosed` 也是实测：同一执行 v1 报 9 条、v2 只报 7 条（差的就是已关闭的），
 *     加 `browseType=all` 后两边一致 —— 所以方言**默认显式要 all**，绝不悄悄少给数据；
 *   · v2 没有当前用户端点、`project` 没有 get 动作 —— 实测/注册表核对过，因此回退 v1。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dialectOf } from '../src/transport/dialects/index.js'
import { probeDialect } from '../src/transport/probe.js'
import { ENTITY_KEYS } from '../src/domain/model.js'
import { REST_V2_SOURCE, REST_V2_MODULES, v2Action } from '../src/transport/dialects/rest-v2.routes.js'
import { pickPageMeta } from '../src/domain/normalize.js'

const dialect = dialectOf('rest-v2', { version: 'ipd5.6' })

test('v2：基址是 /api.php/v2，**认证也走 v2**（/users/login，官方 SDK 用的就是它）', () => {
  assert.equal(dialect.id, 'rest-v2')
  assert.equal(dialect.implemented, true)
  assert.equal(dialect.basePath, '/api.php/v2')
  // 实测：POST /api.php/v2/users/login {account,password} → {status,token,user}，该 token 对其它 v2 请求有效
  assert.deepEqual(dialect.tokenSpec('admin', 'pw'), { method: 'POST', path: '/users/login', body: { account: 'admin', password: 'pw' } })
  // 严格模式下**没有任何 v1 基址**（这个字段已经不需要了）
  assert.equal(dialect.tokenBasePath, undefined)
})

test('注册表：26 模块 / 每个动作都有 method+path / 来源版本可追溯', () => {
  assert.equal(REST_V2_SOURCE.package, 'zentao-api')
  assert.equal(REST_V2_SOURCE.version, '0.7.0')
  assert.equal(Object.keys(REST_V2_MODULES).length, 26)
  for (const [moduleName, actions] of Object.entries(REST_V2_MODULES)) {
    assert.ok(actions.length > 0, `${moduleName} 不该是空的`)
    for (const action of actions) {
      assert.match(action.method, /^(GET|POST|PUT|DELETE)$/, `${moduleName}.${action.name} 的方法不合法`)
      assert.match(action.path, /^\//, `${moduleName}.${action.name} 的路径必须以 / 开头`)
    }
  }
})

test('列表路径：任务要执行、需求/Bug 要作用域、计划要产品', () => {
  assert.deepEqual(
    dialect.listSpec('task', { scope: { execution: '2' }, page: 1, limit: 5 }),
    { method: 'GET', path: '/executions/2/tasks', query: { browseType: 'all', pageID: 1, recPerPage: 5 } },
  )
  assert.equal(dialect.listSpec('story', { scope: { product: '1' } }).path, '/products/1/stories')
  assert.equal(dialect.listSpec('bug', { scope: { product: '1' } }).path, '/products/1/bugs')
  assert.equal(dialect.listSpec('plan', { scope: { product: '1' } }).path, '/products/1/productplans')
  assert.equal(dialect.listSpec('project', {}).path, '/projects')
  assert.equal(dialect.listSpec('product', {}).path, '/products')
  // 作用域优先级：执行 > 项目 > 产品（与 v1 的取法一致）
  assert.equal(dialect.listSpec('story', { scope: { execution: '2', product: '1' } }).path, '/executions/2/stories')
})

test('列表：**默认 browseType=all**（v2 的默认是 unclosed，会悄悄少给已关闭的条目）', () => {
  const spec = dialect.listSpec('task', { scope: { execution: '2' } })
  assert.equal(spec.query.browseType, 'all', '默认必须是 all —— v1 报 9 条、v2 默认只报 7 条，加 all 才一致')
  // 调用方仍可覆盖
  assert.equal(dialect.listSpec('task', { scope: { execution: '2' }, browseType: 'assignedtome' }).query.browseType, 'assignedtome')
  // 分页参数名是 v2 的 pageID / recPerPage（不是 v1 的 page / limit）
  assert.deepEqual(Object.keys(dialect.listSpec('task', { scope: { execution: '2' }, page: 2, limit: 3 }).query).sort(),
    ['browseType', 'pageID', 'recPerPage'])
})

test('列表：缺必填路径参数时**明确报错**（而不是拼出带 {…} 的坏地址）', () => {
  assert.throws(() => dialect.listSpec('task', {}), (error) => {
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, /executionID|execution/)
    return true
  })
})

test('详情路径：**每个受支持实体都有 v2 路径**（注册表或实测特例），严格模式下无一回退 v1', () => {
  assert.equal(dialect.detailSpec('task', '9').path, '/tasks/9')
  assert.equal(dialect.detailSpec('plan', '1').path, '/productplans/1')
  assert.equal(dialect.detailSpec('product', '1').path, '/products/1')
  assert.equal(dialect.detailSpec('user', '2').path, '/users/2')

  // **实测特例**：注册表没列 get，但路由实测存在（返回的是 API 级"对象不存在"而不是 404/网页）
  for (const [entity, path] of [
    ['project', '/projects/1'], ['build', '/builds/1'], ['release', '/releases/1'],
    ['testtask', '/testtasks/1'], ['testcase', '/testcases/1'],
  ]) {
    const spec = dialect.detailSpec(entity, '1')
    assert.equal(spec.path, path, entity)
    assert.equal(spec.basePath, undefined, entity + ' 应当走 v2')
  }

  // 更强的一条：**所有**受支持实体在 v2 下都不需要回退 v1
  for (const entity of ENTITY_KEYS) {
    const spec = dialect.detailSpec(entity, '1')
    assert.equal(spec.basePath, undefined, entity + ' 在 v2 下不应回退 v1')
  }
})

test('“我是谁”：v2 没有该端点，且**不需要** —— 账号来自凭据（官方 SDK 同理）', () => {
  assert.equal(dialect.meSpec(), undefined, 'v2 不提供 me 端点，也不该回退 v1')
  assert.equal(dialect.capabilities.meFromCredentials, true)
})

test('严格 v2-only：没有 v2 路径的能力**直接报错**，且 auto 探测不得落到 v1', async () => {
  const strict = dialectOf('rest-v2', { version: 'ipd5.6', avoidV1: true })
  // 唯一仍然"没有 v2 形态"的动作是 comment（v1/v2 都没有独立端点）
  assert.throws(() => strict.writeSpec('comment', { entity: 'task', id: '9', payload: { comment: 'x' } }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /没有.*独立端点/)
    return true
  })

  // ⚠️ 关键：auto + avoidV1 时，探测候选必须收窄成只剩 v2 ——
  // 否则解析出 v1 方言之后，请求就真的打到 /api.php/v1 了（avoidV1 形同虚设）。
  const tried = []
  const transport = {
    async request (options) {
      tried.push(String(options.path))
      return { ok: false, status: 404, contentType: 'application/json', json: { error: 'not found' }, url: 'x' }
    },
  }
  let outcome
  try {
    outcome = await probeDialect({ transport, base: 'http://127.0.0.1/zentao', token: 't', configured: 'auto', order: ['rest-v2'] })
  } catch (error) {
    outcome = { threw: error }
  }
  // 不管是抛错还是返回结论，都**不能**是 v1
  const resolved = outcome?.dialectId ?? outcome?.dialect?.id
  assert.notEqual(resolved, 'rest-v1', 'v2 探测失败时绝不能退到 v1')
  assert.equal(resolved, undefined, '严格模式下探测失败就是失败，不该给出方言')
  // 而且**一次 v1 探测请求都没发**
  assert.ok(tried.length > 0, '确实探测过（说明断言不是空转）')
  assert.ok(tried.every((path) => !path.includes('/api.php/v1')), '不得向 v1 发任何探测请求: ' + tried.join(','))
})

test('写入：路径取自 v2 注册表；**已校准的动作标 verified，未校准的仍标 false**', () => {
  // 已逐条真机校准（design 附录 C.42）：任务 create/update/delete/start/finish/close、
  // Bug resolve/close/confirm
  const finish = dialect.writeSpec('finish', { entity: 'task', id: '9', payload: { currentConsumed: 1, finishedDate: '2026-10-07 10:00:00', realStarted: '2026-10-07 09:00:00' } })
  assert.equal(finish.method, 'PUT')
  assert.equal(finish.path, '/tasks/9/finish')
  assert.equal(finish.verified, true, '任务完成已在真机校准')

  const closeBug = dialect.writeSpec('close', { entity: 'bug', id: '1', payload: { comment: 'x' } })
  assert.equal(closeBug.method, 'PUT')
  assert.equal(closeBug.path, '/bugs/1/close')
  assert.equal(closeBug.verified, true)

  const create = dialect.writeSpec('create', { entity: 'task', payload: { name: 't', execution: '2' } })
  assert.equal(create.method, 'POST')
  assert.equal(create.path, '/tasks')
  assert.equal(create.verified, true)

  // **需求**：v2 的**裸** `POST /stories` 不是 API 路由（实测返回网页端登录页 JSON），
  // 但带 id 的路径是好的 —— `PUT /stories/{id}/close` 实测生效（状态 → closed）。
  const storyClose = dialect.writeSpec('close', { entity: 'story', id: '6', payload: { closedReason: 'done' }, reason: 'x' })
  assert.equal(storyClose.path, '/stories/6/close')
  assert.equal(storyClose.basePath, undefined, '走 v2，不再回退 v1')
  assert.match(storyClose.note, /v2 注册表/)

  // 需求创建：真路径是**项目作用域**（实测 /projects/1/stories 返回 API 校验错误而不是网页端）
  const storyCreate = dialect.writeSpec('create', { entity: 'story', payload: { product: '1', project: '1', title: 't', pri: 3, spec: 's', category: 'feature' } })
  assert.equal(storyCreate.method, 'POST')
  assert.equal(storyCreate.path, '/projects/1/stories')
  // 没给项目 → 本地就报错并说清为什么要它（注意 payload 要满足 v1 白名单的必填，否则先报那个）
  assert.throws(() => dialect.writeSpec('create', { entity: 'story', payload: { product: '1', title: 't', spec: 's', pri: 3, category: 'feature' } }),
    (error) => {
      assert.equal(error.code, 'VALIDATION')
      assert.match(error.message, /项目作用域|payload\.project/)
      return true
    })

  // ⚠️ **已知边界**：v2 注册表里有的写能力（如 `PUT /productplans/{id}`）本插件**还没暴露** ——
  // 因为 v1 的字段白名单里没有它，凭空发 v2 形状属于未校准。这类能力等校准后再开，现在如实报不支持。
  assert.throws(() => dialect.writeSpec('update', { entity: 'plan', id: '1', payload: { patch: { title: 'x' } } }),
    /暂不支持修改「产品计划」/)
})

test('v2 字段差异①：单值字段要**字符串**（v1 要数组，v2 传数组会报 User does not exist）', () => {
  const spec = dialect.writeSpec('create', { entity: 'task', payload: { name: 't', execution: '2', assignedTo: ['admin'] } })
  assert.equal(spec.body.assignedTo, 'admin', '单个元素必须降成字符串')
  // 已经是字符串时保持不变
  const again = dialect.writeSpec('create', { entity: 'task', payload: { name: 't', execution: '2', assignedTo: 'admin' } })
  assert.equal(again.body.assignedTo, 'admin')
})

test('v2 字段差异②：需要上下文的字段缺了就**本地报错并说清要传什么**', () => {
  // 实测：finish 缺 realStarted → 「『实际开始』不能为空」
  assert.throws(
    () => dialect.writeSpec('finish', { entity: 'task', id: '9', payload: { currentConsumed: 1, finishedDate: '2026-10-07 10:00:00' } }),
    (error) => {
      assert.equal(error.code, 'VALIDATION')
      assert.match(error.message, /realStarted/)
      assert.match(error.message, /zentao_get/)
      return true
    },
  )
  // 实测：任务 activate 缺 left、Bug activate 缺 openedBuild
  assert.throws(() => dialect.writeSpec('activate', { entity: 'task', id: '9', payload: {} }), /left/)
  assert.throws(() => dialect.writeSpec('activate', { entity: 'bug', id: '1', payload: {} }), /openedBuild/)
  // 给全了就能过
  assert.equal(dialect.writeSpec('activate', { entity: 'task', id: '9', payload: { left: 2 } }).path, '/tasks/9/activate')
})

test('activate / confirm：v2 专属动作（真机校准过），路径与已校准标记都要对', () => {
  // 实测：任务 activate {left:2} → closed→doing；需求 activate **无需额外字段** → closed→draft；
  //       Bug activate {openedBuild:'trunk'} → closed→active；Bug confirm → ok
  const taskActivate = dialect.writeSpec('activate', { entity: 'task', id: '3', payload: { left: 2, comment: 'x' } })
  assert.equal(taskActivate.method, 'PUT')
  assert.equal(taskActivate.path, '/tasks/3/activate')
  assert.equal(taskActivate.verified, true)

  const storyActivate = dialect.writeSpec('activate', { entity: 'story', id: '4', payload: {} })
  assert.equal(storyActivate.path, '/stories/4/activate')
  assert.equal(storyActivate.verified, true, '需求重开不需要额外字段（实测）')

  const bugActivate = dialect.writeSpec('activate', { entity: 'bug', id: '1', payload: { openedBuild: 'trunk' } })
  assert.equal(bugActivate.path, '/bugs/1/activate')
  assert.equal(bugActivate.verified, true)

  const confirm = dialect.writeSpec('confirm', { entity: 'bug', id: '1', payload: { comment: 'ok' } })
  assert.equal(confirm.path, '/bugs/1/confirm')
  assert.equal(confirm.verified, true)

  // confirm 在注册表里要求 ipd5.5：版本不足时要报可读错误（本机 5.6 ✓）
  const old = dialectOf('rest-v2', { version: 'ipd5.0' })
  assert.throws(() => old.writeSpec('confirm', { entity: 'bug', id: '1' }), /ipd5\.5/)
})

test('v2 注册表里**没有**的动作：assign 用更新、log_effort 用更新（都是纯 v2 请求）', () => {
  // 指派：PUT /{plural}/{id} {assignedTo}（实测 Bug 的 assignedTo "" → "admin" 且 assignedDate 变化）
  const assign = dialect.writeSpec('assign', { entity: 'task', id: '9', payload: { assignedTo: 'admin', left: 2 } })
  assert.equal(assign.method, 'PUT')
  assert.equal(assign.path, '/tasks/9')
  assert.equal(assign.body.assignedTo, 'admin')
  assert.equal(assign.body.left, 2)
  assert.equal(assign.basePath, undefined, '纯 v2：不发任何 v1 请求')
  assert.match(assign.note, /v2 没有 assign 动作/)

  const bugAssign = dialect.writeSpec('assign', { entity: 'bug', id: '1', payload: { assignedTo: ['admin'] } })
  assert.equal(bugAssign.path, '/bugs/1')
  assert.equal(bugAssign.body.assignedTo, 'admin', '数组要降成字符串')

  // 工时：v2 没有任何 effort 端点 → PUT {consumed,left}；**必须如实说明不产生工时明细**
  const effort = dialect.writeSpec('log_effort', { entity: 'task', id: '9', payload: { consumed: 1.5, left: 2, date: '2026-10-08' } })
  assert.equal(effort.method, 'PUT')
  assert.equal(effort.path, '/tasks/9')
  assert.equal(effort.body.consumed, 1.5)
  assert.match(effort.note, /不会产生工时明细/)

  // 指派缺 assignedTo、工时缺 consumed → 本地就报错
  assert.throws(() => dialect.writeSpec('assign', { entity: 'task', id: '9', payload: {} }), /assignedTo/)
  assert.throws(() => dialect.writeSpec('log_effort', { entity: 'task', id: '9', payload: {} }), /consumed/)
})

test('严格 v2-only：`comment` 在 v2/v1 都没有端点 —— 明确报不支持并给出替代做法', () => {
  assert.throws(() => dialect.writeSpec('comment', { entity: 'task', id: '9', payload: { comment: 'x' } }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /没有.*独立端点/)
    assert.match(error.message, /start\/finish|comment 字段/)
    return true
  })
})

test('**假成功守卫**：HTTP 200 但响应是网页端登录页时，必须报错（真机踩过）', () => {
  // 实测：`POST /api.php/v2/stories` 返回
  // {"status":"success","data":"{\"title\":\"用户登录\",…\"loginExpired\":true,…}"}
  const loginPage = {
    status: 'success',
    data: '{"title":"用户登录","plugins":{},"loginExpired":true,"referer":"/zentao/product-create.json"}',
  }
  const message = dialect.detectBusinessError(loginPage)
  assert.ok(message, '这种载荷绝不能被当成成功')
  assert.match(message, /网页端|未按注册表|登录态/)

  // 正常的 v2 成功响应不能被误判
  assert.equal(dialect.detectBusinessError({ status: 'success', message: '保存成功', id: '9' }), undefined)
  assert.equal(dialect.detectBusinessError({ status: 'success', tasks: [], pager: {} }), undefined)
})

test('版本门禁：动作要求的 IPD 版本高于服务器时，报可读错误而不是让它 404', () => {
  // `bug.confirm` 在注册表里要求 ipd5.5（本机 5.6 满足，5.0 不满足）
  assert.equal(v2Action('bug', 'confirm').ipd, 'ipd5.5')
  const old = dialectOf('rest-v2', { version: 'ipd5.0' })
  assert.throws(() => old.writeSpec('confirm', { entity: 'bug', id: '1' }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /ipd5\.5/)
    assert.match(error.message, /ipd5\.0/)
    return true
  })
  // 本机 5.6 满足，正常给出路径
  const confirm = dialect.writeSpec('confirm', { entity: 'bug', id: '1' })
  assert.equal(confirm.method, 'PUT')
  assert.equal(confirm.path, '/bugs/1/confirm')
  // 版本未知时不拦（如实放行，让真实请求给出答案）
  const unknown = dialectOf('rest-v2', {})
  assert.equal(unknown.writeSpec('confirm', { entity: 'bug', id: '1' }).path, '/bugs/1/confirm')
})

test('信封：parsePage 用注册表的 resultGetter 取数组键', () => {
  assert.equal(dialect.parsePage('task').plural, 'tasks')
  assert.equal(dialect.parsePage('plan').plural, 'productplans')
  assert.equal(dialect.parsePage('product').plural, 'products')
  assert.equal(v2Action('productplan', 'list').getter, 'productplans')
})

test('详情解包：v2 的 `{status,product,dynamics,…}` 能取出实体', () => {
  const item = dialect.parseItem('product', { status: 'success', product: { id: '1', name: 'p' }, dynamics: [] })
  assert.equal(item.id, '1')
})

test('详情解包：**键名是模块名**（实测 /v2/productplans/1 → {status,productplan,actions}）', () => {
  // 真机踩过：实体名是 `plan`，而 v2 的单数键是模块名 `productplan` —— 用实体名解包会取不到 id
  const item = dialect.parseItem('plan', { status: 'success', productplan: { id: '1', title: '计划' }, actions: [] })
  assert.equal(item.id, '1')
  assert.equal(item.title, '计划')
  // 实体名与模块名一致的实体照旧
  assert.equal(dialect.parseItem('task', { status: 'success', task: { id: '9' } }).id, '9')
})

test('业务失败：v2 的 HTTP 200 + status=fail 必须被识别（不能当成成功）', () => {
  assert.equal(dialect.detectBusinessError({ status: 'success', products: [] }), undefined)
  assert.equal(dialect.detectBusinessError({ status: 'fail', message: '名称不能为空' }), '名称不能为空')
  assert.match(dialect.detectBusinessError({ status: 'fail', message: { name: ['名称不能为空', '太长了'] } }), /名称不能为空/)
})

test('分页元数据：v2 的 pager 字段（recTotal/recPerPage/pageID）要能读出来', () => {
  // 实测响应形状（本机 IPD 5.6，recPerPage=3 被服务端采纳）
  const meta = pickPageMeta({
    status: 'success',
    tasks: [{ id: 9 }],
    pager: { offset: 0, recTotal: 7, recPerPage: 3, pageCookie: null, pageTotal: 3, pageID: 1, moduleName: 'execution', methodName: 'task' },
  })
  assert.deepEqual(meta, { page: 1, total: 7, limit: 3 })

  // v1 的形状仍然要认（回归）
  assert.deepEqual(pickPageMeta({ page: 2, total: 20, limit: 5 }), { page: 2, total: 20, limit: 5 })
  // 都没有时如实给 undefined，不编造
  assert.deepEqual(pickPageMeta({ products: [] }), { page: undefined, total: undefined, limit: undefined })
})

test('能力声明：v2 的服务端筛选为真、分页参数名不同、我的地盘有聚合端点', () => {
  assert.equal(dialect.capabilities.serverFilters, true)
  assert.deepEqual(dialect.capabilities.paginationParams, ['pageID', 'recPerPage'])
  assert.equal(dialect.capabilities.myAggregate, true)
  // v1 对照：它的筛选实测全被忽略
  assert.equal(dialectOf('rest-v1').capabilities.serverFilters, false)
})


test('v2 字段差异③：Bug 创建要 **productID**（v1 用 product）——实测缺它服务端报 Missing required parameter', () => {
  const spec = dialect.writeSpec('create', { entity: 'bug', payload: { product: '1', title: 'b', severity: 3, pri: 3, type: 'codeerror', steps: 'x', openedBuild: 'trunk' } })
  assert.equal(spec.path, '/bugs')
  assert.equal(spec.body.productID, '1', '必须补出 productID')
  assert.equal(spec.verified, true, 'Bug 创建已真机校准（带上 productID 后 200 + id）')
  // 显式给了 productID 就用它
  const again = dialect.writeSpec('create', { entity: 'bug', payload: { productID: '7', product: '1', title: 'b', severity: 3, pri: 3, type: 'codeerror', steps: 'x', openedBuild: 'trunk' } })
  assert.equal(again.body.productID, '7')
})

test('需求更新 / Bug 更新：v2 路径已真机校准（改成不同的值并读回确认）', () => {
  assert.equal(dialect.writeSpec('update', { entity: 'story', id: '6', payload: { patch: { pri: 1 } } }).verified, true)
  assert.equal(dialect.writeSpec('update', { entity: 'bug', id: '4', payload: { patch: { pri: 1 } } }).verified, true)
})
