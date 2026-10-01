/**
 * REST v1 方言的离线测试（路径、写形状、错误映射）。
 *
 * 这里的断言全部对着**官方手册明文**的路径写 —— 因为写错路径是"看起来能用、
 * 实际打到别的端点"这类最危险的错误。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createRestV1Dialect } from '../src/transport/dialects/rest-v1.js'
import { dialectOf } from '../src/transport/dialects/index.js'
import { entityOf, writeActionOf } from '../src/domain/model.js'

const dialect = createRestV1Dialect({ base: 'https://zt.example.com' })

test('列表路径：无父资源的实体直接用集合路径', () => {
  assert.equal(dialect.listSpec('product', { page: 1, limit: 50 }).path, '/products')
  assert.equal(dialect.listSpec('project', { page: 1 }).path, '/projects')
  assert.equal(dialect.listSpec('user', { page: 1 }).path, '/users')
  assert.equal(dialect.listSpec('feedback', { page: 1 }).path, '/feedbacks')
  assert.equal(dialect.listSpec('ticket', { page: 1 }).path, '/tickets')
})

test('测试单列表：**不带范围**的本版本返回 200 空 body，但**带项目范围**可用（实测修正）', () => {
  // 上一轮我曾整体判为"不支持"，实测发现是**只有不带范围的那种写法坏**：
  //   GET /testtasks            → 200 但 body 为空（0 字节）
  //   GET /projects/2/testtasks → 200 + {page,total,limit,testtasks}
  // 权威路由表 config/apiv1.php L147-149 确认两者都存在。
  assert.equal(dialect.listSpec('testtask', { scope: { project: '2' }, page: 1 }).path, '/projects/2/testtasks')
  // 不给项目范围时必须明确要求，而不是去发那个注定空的请求
  assert.throws(
    () => dialect.listSpec('testtask', { page: 1 }),
    (error) => /project/.test(error.message) || /范围/.test(error.message),
  )
  // 详情路由确实存在（权威路由表 /testtasks/:id）
  assert.equal(dialect.detailSpec('testtask', '9').path, '/testtasks/9')
})

test('详情路径的资源名必须是**复数**且与列表路径的那一段可能不同（实测）', () => {
  assert.equal(dialect.detailSpec('bug', '1').path, '/bugs/1')
  assert.equal(dialect.detailSpec('task', '1').path, '/tasks/1')
  // 实测：列表是 /products/:id/plans，但详情是 /productplans/:id（/plans/:id 返回 {"error":"not found"} = 路由不存在）
  assert.equal(dialect.detailSpec('plan', '1').path, '/productplans/1')
  assert.equal(dialect.detailSpec('release', '1').path, '/releases/1')
  assert.equal(dialect.detailSpec('build', '1').path, '/builds/1')
  assert.equal(dialect.detailSpec('testcase', '1').path, '/testcases/1')
})

test('列表路径：任务挂在执行下、Bug 挂在产品下（手册明文）', () => {
  assert.equal(dialect.listSpec('task', { scope: { execution: '13' }, page: 1 }).path, '/executions/13/tasks')
  assert.equal(dialect.listSpec('bug', { scope: { product: '1' }, page: 1 }).path, '/products/1/bugs')
  assert.equal(dialect.listSpec('execution', { scope: { project: '12' }, page: 1 }).path, '/projects/12/executions')
})

test('列表路径：需求接受三种范围，缺范围时明确报错', () => {
  assert.equal(dialect.listSpec('story', { scope: { product: '1' }, page: 1 }).path, '/products/1/stories')
  assert.equal(dialect.listSpec('story', { scope: { project: '2' }, page: 1 }).path, '/projects/2/stories')
  assert.equal(dialect.listSpec('story', { scope: { execution: '3' }, page: 1 }).path, '/executions/3/stories')
  assert.throws(() => dialect.listSpec('story', { scope: {}, page: 1 }), /必须指定范围/)
  assert.throws(() => dialect.listSpec('task', { scope: {}, page: 1 }), /必须指定范围/)
  assert.throws(() => dialect.listSpec('bug', { scope: {}, page: 1 }), /必须指定范围/)
})

test('分页参数用 page + limit（手册在 /projects、/users 明文写了这两个名字）', () => {
  const spec = dialect.listSpec('project', { page: 2, limit: 20 })
  assert.deepEqual(spec.query, { page: 2, limit: 20 })
  assert.deepEqual(dialect.capabilities.paginationParams, ['page', 'limit'])
  // 条件过滤参数名手册未列 → 必须如实声明不支持服务端过滤
  assert.equal(dialect.capabilities.serverFilters, false)
})

test('能力声明必须反映**实测**结论（无服务端过滤、status 有害、深链格式）', () => {
  const caps = dialect.capabilities
  // 实测：q / title / assignedTo / keywords / browseType / pri / severity 传不可能匹配的值仍返回全部
  assert.equal(caps.serverFilters, false, '实测过滤参数全部被忽略 → 只能本地过滤')
  // 实测：status=<任意值>（含真实状态 closed）都会把结果清空为 0 条 → 绝不能发送
  assert.deepEqual(caps.harmfulParams, ['status'])
  assert.equal(caps.webLinkFormat, '<base>/<entity>-view-<id>.html', '深链格式由禅道自身路由代码确证')
  // 列表请求**只**带分页参数，绝不带会破坏查询的 status
  const spec = dialect.listSpec('bug', { scope: { product: '1' }, page: 1, limit: 20 })
  assert.deepEqual(Object.keys(spec.query ?? {}).sort(), ['limit', 'page'])
})

test('详情路径与 id 校验', () => {
  assert.equal(dialect.detailSpec('task', '18').path, '/tasks/18')
  assert.equal(dialect.detailSpec('bug', 5).path, '/bugs/5')
  assert.equal(dialect.detailSpec('execution', '13').path, '/executions/13')
  assert.throws(() => dialect.detailSpec('task', ''), /必须提供 id/)
})

test('认证头就叫 Token（有一页写小写，HTTP 头大小写不敏感）', () => {
  assert.deepEqual(dialect.authHeaders('abc'), { Token: 'abc' })
  assert.deepEqual(dialect.authHeaders(''), {})
})

test('取 Token 的形状（手册明文：POST /tokens + account/password）', () => {
  assert.deepEqual(dialect.tokenSpec('admin', 'pw'), {
    method: 'POST', path: '/tokens', body: { account: 'admin', password: 'pw' },
  })
  assert.equal(dialect.meSpec().path, '/user')
})

test('新建任务走父资源路径，且必须给出执行', () => {
  const spec = dialect.writeSpec('create', {
    entity: 'task',
    payload: { name: 't', type: 'devel', execution: '13', assignedTo: 'admin', estStarted: '2026-03-01', deadline: '2026-03-10' },
  })
  assert.equal(spec.method, 'POST')
  assert.equal(spec.path, '/executions/13/tasks')
  assert.equal(spec.verified, true)
  // assignedTo 在手册里是数组
  assert.deepEqual(spec.body.assignedTo, ['admin'])
  assert.throws(() => dialect.writeSpec('create', { entity: 'task', payload: { name: 't' } }), /必须给出所属执行/)
})

test('新建 Bug 走父资源路径，且必须给出产品', () => {
  const spec = dialect.writeSpec('create', { entity: 'bug', payload: { product: '1', title: 'b', severity: 1, pri: 1, type: 'codeerror' } })
  assert.equal(spec.path, '/products/1/bugs')
  assert.equal(spec.verified, true)
  assert.throws(() => dialect.writeSpec('create', { entity: 'bug', payload: { title: 'b' } }), /必须给出所属产品/)
})

test('新建需求是 POST /stories，且 spec（描述）必填、reviewer 必须是数组（实测）', () => {
  const spec = dialect.writeSpec('create', {
    entity: 'story',
    payload: { title: 's', spec: '描述', product: 1, pri: 1, category: 'feature', reviewer: ['2'] },
  })
  assert.equal(spec.method, 'POST')
  assert.equal(spec.path, '/stories')
  assert.equal(spec.verified, true)
  // 实测：缺 spec 时服务端报「『描述』不能为空。」→ 本地就给出清晰错误
  assert.throws(
    () => dialect.writeSpec('create', { entity: 'story', payload: { title: 's', product: 1 } }),
    /必须提供 spec/,
  )
  assert.throws(
    () => dialect.writeSpec('create', { entity: 'story', payload: { title: 's', spec: 'x', reviewer: '2' } }),
    /reviewer 必须传数组/,
  )
})

test('修改任务走 PUT /tasks/:id，并且**丢弃未文档化的字段**并如实汇报', () => {
  const spec = dialect.writeSpec('update', {
    entity: 'task', id: '18',
    payload: { patch: { pri: 1, deadline: '2026-03-10', status: 'closed', 乱写: 1 } },
  })
  assert.equal(spec.method, 'PUT')
  assert.equal(spec.path, '/tasks/18')
  assert.equal(spec.verified, true)
  assert.deepEqual(Object.keys(spec.body).sort(), ['deadline', 'pri'])
  assert.deepEqual(spec.dropped.sort(), ['status', '乱写'])
})

test('需求修改走动作端点 POST /stories/:id/change，只接受三个字段', () => {
  const spec = dialect.writeSpec('update', { entity: 'story', id: '1', payload: { patch: { title: 'x', spec: 'y', pri: 9 } } })
  assert.equal(spec.method, 'POST')
  assert.equal(spec.path, '/stories/1/change')
  assert.deepEqual(Object.keys(spec.body).sort(), ['spec', 'title'])
  assert.deepEqual(spec.dropped, ['pri'])
})

test('任务状态迁移是动作端点，且必填项会被校验（这是最容易做错的一处）', () => {
  const start = dialect.writeSpec('start', { entity: 'task', id: '18', payload: { left: 2, consumed: 1, comment: 'go' } })
  assert.equal(start.method, 'POST')
  assert.equal(start.path, '/tasks/18/start')
  assert.equal(start.verified, true)
  assert.throws(() => dialect.writeSpec('start', { entity: 'task', id: '18', payload: { consumed: 1 } }), /必须提供 left/)

  const finish = dialect.writeSpec('finish', { entity: 'task', id: '18', payload: { currentConsumed: 1, finishedDate: '2026-03-10 15:30:00' } })
  assert.equal(finish.path, '/tasks/18/finish')
  assert.equal(finish.verified, true)
  assert.throws(() => dialect.writeSpec('finish', { entity: 'task', id: '18', payload: { currentConsumed: 1 } }), /currentConsumed.*finishedDate/)
})

test('删除：任务与 Bug 的 DELETE 路径已文档化', () => {
  assert.deepEqual(dialect.writeSpec('delete', { entity: 'task', id: '18' }).method, 'DELETE')
  assert.equal(dialect.writeSpec('delete', { entity: 'task', id: '18' }).path, '/tasks/18')
  assert.equal(dialect.writeSpec('delete', { entity: 'bug', id: '5' }).verified, true)
})

test('doctor 的未校准清单**只能列出该动作真正支持的实体**（防"根本不支持的组合"混进来）', () => {
  const notes = dialect.listWriteShapeNotes()
  for (const entry of notes) {
    const supported = writeActionOf(entry.action).entities
    for (const entity of entry.entities) {
      assert.ok(supported.includes(entity),
        `${entry.action} 的未校准清单里出现了它不支持的实体 ${entity}（受支持：${supported.join('/')}）`)
    }
  }
  // 实测后只剩 comment 仍不可用
  assert.deepEqual(notes.map((n) => n.action), ['comment'])
  assert.deepEqual(notes[0].entities, ['story', 'task', 'bug'])
})

test('写操作的 verified 标记必须反映**真实证据**（手册明文 或 真机实测）', () => {
  // 仍然不可用：comment（实测反证 + 权威路由表里根本没有 comment 路由）
  for (const [action, spec] of [
    ['comment', { entity: 'task', id: '18', payload: { comment: 'hi' } }],
    ['comment', { entity: 'bug', id: '5', payload: { comment: 'hi' } }],
  ]) {
    const built = dialect.writeSpec(action, spec)
    assert.equal(built.verified, false, `${action} 尚未确认，不应被标成已核验`)
    assert.ok(built.note, `${action} 必须带说明`)
  }
  // 反安慰剂：resolve 只对 Bug 有实测证据。给它一个任务时，构建器仍会拼出 bug 形状的请求，
  // 但 verified 必须是 false（于是默认闸门会拦住它，而不是悄悄发出去）。
  const resolveTask = dialect.writeSpec('resolve', { entity: 'task', id: '1', payload: { resolution: 'fixed', resolvedBuild: 'trunk' } })
  assert.equal(resolveTask.verified, false, 'resolve×task 没有证据，不能被标成已核验')

  // 已在本机真实禅道实测成功 → 必须翻正
  const resolveBug = dialect.writeSpec('resolve', { entity: 'bug', id: '5', payload: { resolution: 'fixed', resolvedBuild: 'trunk' } })
  assert.equal(resolveBug.verified, true, 'resolve×bug 已实测确认（POST /bugs/:id/resolve）')
  const closeBug = dialect.writeSpec('close', { entity: 'bug', id: '5', payload: { comment: 'x' } })
  assert.equal(closeBug.verified, true, 'close×bug 已实测确认（POST /bugs/:id/close）')
  const assignBug = dialect.writeSpec('assign', { entity: 'bug', id: '5', payload: { assignedTo: '2' } })
  assert.equal(assignBug.verified, true, 'assign×bug 已实测确认（POST /bugs/:id/assign）')
  const assignTask = dialect.writeSpec('assign', { entity: 'task', id: '1', payload: { assignedTo: 'admin', left: 4 } })
  assert.equal(assignTask.verified, true, 'assign×task 已实测确认（POST /tasks/:id/assignto）')
  assert.equal(assignTask.path, '/tasks/1/assignto')
  // 实测：任务指派缺 left 会被服务端拒绝 → 本地就拦住
  assert.throws(
    () => dialect.writeSpec('assign', { entity: 'task', id: '1', payload: { assignedTo: 'admin' } }),
    /必须提供 left/,
  )
  const startTask = dialect.writeSpec('start', { entity: 'task', id: '1', payload: { left: 2 } })
  assert.equal(startTask.verified, true, 'start×task 已实测确认（之后 status=doing、left/consumed 更新）')
  const finishTask = dialect.writeSpec('finish', { entity: 'task', id: '1', payload: { currentConsumed: 2, finishedDate: '2026-09-30' } })
  assert.equal(finishTask.verified, true, 'finish×task 已实测确认（之后 status=done、consumed 累加）')
  const deleteStory = dialect.writeSpec('delete', { entity: 'story', id: '1', reason: 'x' })
  assert.equal(deleteStory.verified, true, 'delete×story 已实测确认（软删除）')
  const createStory = dialect.writeSpec('create', { entity: 'story', payload: { product: '1', title: 't', spec: 's', pri: 2, category: 'feature', reviewer: ['2'] } })
  assert.equal(createStory.verified, true, 'create×story 已实测确认（spec 必填、reviewer 必须是数组）')

  // 任务与需求的 close、三种实体的工时，都已在真机验证（实测：任务 done→closed、需求 reviewing→closed）
  const closeTask = dialect.writeSpec('close', { entity: 'task', id: '1', reason: 'x' })
  assert.equal(closeTask.verified, true, 'close×task 已实测确认（之后 status=closed）')
  const closeStory = dialect.writeSpec('close', { entity: 'story', id: '1', reason: 'x', payload: { closedReason: 'willnotdo' } })
  assert.equal(closeStory.verified, true, 'close×story 已实测确认（之后 status=closed）')

  // 工时：端点是 /estimate（既不是 /efforts 也不是 /recordestimate），字段按实测
  const effortTask = dialect.writeSpec('log_effort', { entity: 'task', id: '1', payload: { date: '2026-09-30', consumed: 2, left: 4, work: 'x' } })
  assert.equal(effortTask.path, '/tasks/1/estimate')
  assert.equal(effortTask.verified, true, 'log_effort×task 已实测确认')
  const effortBug = dialect.writeSpec('log_effort', { entity: 'bug', id: '5', payload: { dates: '2026-09-30', consumed: 1, work: 'x' } })
  assert.equal(effortBug.path, '/bugs/5/estimate')
  assert.equal(effortBug.verified, true, 'log_effort×bug 已实测确认')
  const effortStory = dialect.writeSpec('log_effort', { entity: 'story', id: '9', payload: { consumed: 1 } })
  assert.equal(effortStory.path, '/stories/9/estimate')
  assert.equal(effortStory.verified, true, 'log_effort×story 已实测确认')
  // 必填 consumed（兼容旧字段名 hours）
  assert.throws(() => dialect.writeSpec('log_effort', { entity: 'task', id: '1', payload: {} }), /必须提供 consumed/)
  assert.equal(dialect.writeSpec('log_effort', { entity: 'task', id: '1', payload: { hours: 3 } }).body.consumed, 3)

  // **策略承诺兑现**：服务层强制要求的 reason 会被注入 payload.reason，
  // 方言必须把它落到 comment 上（否则等于无声变更）。这里模拟服务层的注入。
  const closeWithReason = dialect.writeSpec('close', { entity: 'bug', id: '5', payload: { reason: '校准理由' } })
  assert.equal(closeWithReason.body.comment, '校准理由', 'reason 必须被映射成 comment 发出去')
  assert.equal(closeWithReason.body.reason, undefined, 'reason 不该作为未知字段发出去')
  const resolveWithReason = dialect.writeSpec('resolve', { entity: 'bug', id: '5', payload: { resolution: 'fixed', resolvedBuild: 'trunk', reason: '校准理由' } })
  assert.equal(resolveWithReason.body.comment, '校准理由')

  // 但并非"全部"都确认了 → 总开关仍是 false，doctor 仍要列出未确认项
  assert.equal(dialect.writeShapesVerified, false)
  assert.ok(dialect.listWriteShapeNotes().length > 0)
})

test('解决 Bug 必须给 resolution；指派必须给 assignee（任务还要 left）', () => {
  assert.throws(() => dialect.writeSpec('resolve', { entity: 'bug', id: '5', payload: {} }), /必须提供 resolution/)
  assert.throws(() => dialect.writeSpec('assign', { entity: 'task', id: '18', payload: {} }), /必须提供 assignedTo/)
  // 实测：POST /tasks/:id/assignto 缺 left 会被服务端拒绝
  assert.throws(
    () => dialect.writeSpec('assign', { entity: 'task', id: '18', payload: { assignee: 'dev' } }),
    /必须提供 left/,
  )
  const spec = dialect.writeSpec('assign', { entity: 'task', id: '18', payload: { assignee: 'dev', left: 3 } })
  assert.equal(spec.method, 'POST')
  assert.equal(spec.path, '/tasks/18/assignto')
  assert.deepEqual(spec.body, { assignedTo: ['dev'], left: 3 })
  // Bug 走另一个动作端点，assignedTo 是单值
  const bugSpec = dialect.writeSpec('assign', { entity: 'bug', id: '5', payload: { assignedTo: 'dev', comment: 'c' } })
  assert.equal(bugSpec.path, '/bugs/5/assign')
  assert.deepEqual(bugSpec.body, { assignedTo: 'dev', comment: 'c' })
})

test('详情是裸对象；包装形状也能容错', () => {
  assert.equal(dialect.parseItem('task', { id: 22, name: 'x' }).id, 22)
  assert.equal(dialect.parseItem('task', { tasks: { id: 23 } }).id, 23)
  assert.equal(dialect.parseItem('task', { data: [{ id: 24 }] }).id, 24)
})

test('业务错误检测：数值 status=0 是失败，但实体的 status:"doing" 不是', () => {
  assert.match(dialect.detectBusinessError({ status: 0, msg: 'error', result: [] }), /失败/)
  assert.equal(dialect.detectBusinessError({ status: 'doing', id: 1 }), undefined)
  assert.equal(dialect.detectBusinessError({ status: 1, msg: 'success', result: [] }), undefined)
  assert.equal(dialect.detectBusinessError({ message: 'success' }), undefined)
  assert.match(dialect.detectBusinessError({ error: '字段不合法' }), /字段不合法/)
  assert.match(dialect.detectBusinessError({ result: 'fail' }), /result=fail/)
})

test('HTTP 错误映射（401/404/405/409 各有专门文案）', () => {
  const response = (status) => ({ status, ok: false, url: 'https://zt/x', method: 'PUT', contentType: 'application/json', json: { error: 'e' }, text: '' })
  assert.equal(dialect.parseError(response(401)).code, 'AUTH_EXPIRED')
  assert.equal(dialect.parseError(response(404)).code, 'NOT_FOUND')
  assert.equal(dialect.parseError(response(409)).code, 'CONFLICT')
  const unsupported = dialect.parseError(response(405))
  assert.equal(unsupported.code, 'UNSUPPORTED')
  assert.match(unsupported.message, /尚未实测校准/)
  assert.equal(dialect.parseError(response(422)).code, 'VALIDATION')
  assert.equal(dialect.parseError(response(503)).code, 'NETWORK')
})

test('网页深链与方言注册表', () => {
  assert.equal(dialect.webLink('https://zt.example.com', 'bug', '4821'), 'https://zt.example.com/bug-view-4821.html')
  assert.equal(dialect.webLink('https://zt.example.com/zentao/', 'task', '18'), 'https://zt.example.com/zentao/task-view-18.html')

  assert.equal(dialectOf('rest-v1').implemented, true)
  assert.equal(dialectOf('legacy-api').implemented, false)
  assert.equal(dialectOf('rest-v2').implemented, false)
  assert.throws(() => dialectOf('nope'), /未知 dialect/)
})

test('网页深链的**模块名**必须与禅道真实模块一致（15/15 已在本机实测）', () => {
  // 验证方法（可复跑）：未认证请求 `<模块>-view-1.html`
  //   · 302 → 路由被识别（模块存在，需登录）；location 里的 base64 解码正是该路径
  //   · 200 → **模块名不对**（不存在的模块不经过登录门禁）
  // 实测结果：15/15 识别。其中 `plan` 原本写成 `plan-view-…` → 200，
  // 因为禅道**没有** `plan` 模块，产品计划的模块名是 `productplan`（DB 表 zt_productplan）。
  const expected = {
    product: 'product-view-1.html',
    project: 'project-view-1.html',
    program: 'program-view-1.html',
    execution: 'execution-view-1.html',
    story: 'story-view-1.html',
    task: 'task-view-1.html',
    bug: 'bug-view-1.html',
    user: 'user-view-1.html',
    plan: 'productplan-view-1.html',
    release: 'release-view-1.html',
    build: 'build-view-1.html',
    testcase: 'testcase-view-1.html',
    testtask: 'testtask-view-1.html',
    feedback: 'feedback-view-1.html',
    ticket: 'ticket-view-1.html',
  }
  for (const [entity, path] of Object.entries(expected)) {
    assert.equal(entityOf(entity).webPath('1'), path, `${entity} 的深链模块名不符（实测值见注释）`)
  }
  // 企业版模块位于 extension/<版本>/ 下（本机是 extension/ipd/ticket），路由名仍是模块名
  assert.equal(entityOf('ticket').enterprise, true)
})
