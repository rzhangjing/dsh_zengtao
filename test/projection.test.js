/**
 * 会话上下文与投影单元的离线测试。
 *
 * 为什么这一层必须严格：投影里抠出来的 `productId` / `executionId` 会成为后续
 * **省略 scope 的工具调用的默认范围**。抠错一个值，用户会在错误的范围里查、甚至写。
 * 所以这里的原则是：**宁可派生不出来（还有可靠的一轨兜底），也不要猜出一个错值**。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionContext, currentSessionId, extractSwitchFromEvent, registerZentaoProjection } from '../src/projection.js'

/* ─────────────── 提取：正确形态要认 ─────────────── */

test('参数形态：`switch 12 34` 与 `switch 12`', () => {
  assert.deepEqual(extractSwitchFromEvent({ type: 'command/run', data: { rawInput: 'switch 12 34' } }), { productId: '12', executionId: '34' })
  assert.deepEqual(extractSwitchFromEvent({ type: 'command/run', data: { input: 'switch 12' } }), { productId: '12', executionId: undefined })
  assert.deepEqual(extractSwitchFromEvent({ type: 'command/done', data: { arguments: '  switch 7 8  ' } }), { productId: '7', executionId: '8' })
})

test('整行形态：`/zentao switch 12 34`（不带前导斜杠也认）', () => {
  assert.deepEqual(extractSwitchFromEvent({ type: 'command/run', data: { line: '/zentao switch 12 34' } }), { productId: '12', executionId: '34' })
  assert.deepEqual(extractSwitchFromEvent({ type: 'command/run', data: { commandLine: 'zentao switch 12' } }), { productId: '12', executionId: undefined })
})

/* ─────────────── 提取：危险形态必须不认 ─────────────── */

test('**帮助文本不能被当成参数**：`/zentao help` 的输出里含 "switch <产品id>"', () => {
  // 这正是我 usage 里的那行；从输出里抠参数会把范围设成 productId='<产品id>'
  const event = {
    type: 'command/done',
    data: { text: '/zentao switch [产品编号或名称] [执行编号] —— 设置本会话的默认产品/执行' },
  }
  assert.equal(extractSwitchFromEvent(event), undefined)
})

test('`text` 字段一律不看（它通常是**输出**），即使内容看起来完全合法', () => {
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { text: '/zentao switch 12 34' } }), undefined)
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { text: 'switch 12 34' } }), undefined)
})

test('非数字编号一律拒绝（禅道编号是数字）', () => {
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { rawInput: 'switch abc' } }), undefined)
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { rawInput: 'switch <产品id> [执行id]' } }), undefined)
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { rawInput: '/zentao switch <产品id>' } }), undefined)
})

test('参数形态必须**锚定两端**：不能从长句里抠出 switch', () => {
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { rawInput: '先 switch 12 再 board 34' } }), undefined)
})

test('整行形态必须带命令名：光有 `switch 12` 的行不算', () => {
  assert.equal(extractSwitchFromEvent({ type: 'command/run', data: { line: '跑一下 switch 12 看看' } }), undefined)
})

test('非 command/* 事件一律不认（工具事件、消息事件都不掺和）', () => {
  assert.equal(extractSwitchFromEvent({ type: 'tool/result', data: { rawInput: 'switch 12 34' } }), undefined)
  assert.equal(extractSwitchFromEvent({ type: 'message', data: { rawInput: 'switch 12 34' } }), undefined)
  assert.equal(extractSwitchFromEvent(null), undefined)
  assert.equal(extractSwitchFromEvent('nope'), undefined)
})

/* ─────────────── 投影单元（真正驱动 apply） ─────────────── */

/** 用一个假的 sessionProjections 服务把真正的定义抓出来。 */
function makeProjection () {
  const rec = { definitions: [] }
  const ctx = {
    get: (name) => (name === 'sessionProjections'
      ? { register: (definition) => { rec.definitions.push(definition); return () => {} } }
      : undefined),
  }
  const sessionContext = createSessionContext()
  const dispose = registerZentaoProjection(ctx, sessionContext)
  return { definition: rec.definitions[0], sessionContext, dispose }
}

test('apply：忽略的事件与"同值 switch"都必须返回同一引用', () => {
  const { definition } = makeProjection()
  const state = definition.init()
  assert.equal(definition.apply(state, { type: 'tool/result', data: {} }), state, '忽略的事件要返回同一引用')

  const once = definition.apply(state, { type: 'command/run', data: { rawInput: 'switch 12 34' } })
  assert.notEqual(once, state, '命中时必须产生新状态')
  assert.equal(once.productId, '12')
  assert.equal(once.executionId, '34')

  // command/run 与 command/done 往往带同样的输入：不该再触发一轮下游刷新
  assert.equal(definition.apply(once, { type: 'command/done', data: { rawInput: 'switch 12 34' } }), once)
})

test('apply 绝不抛错：脏事件 / 异常形状都必须原样返回（投影抛错会牵连会话事件处理）', () => {
  // 投影的 apply 跑在会话事件流上，是**每个会话的每个事件**都会经过的地方。
  // 它抛错就不再是"禅道卡片不更新"这种局部故障，而会牵连宿主的事件处理 ——
  // 与"提示词悬空引用"同级的风险，所以这里把"不抛"钉住。
  const { definition } = makeProjection()
  const state = definition.init()
  const garbage = [
    undefined, null, 0, '', 'nope', [], {},
    { type: 'command/run' },
    { type: 'command/run', data: null },
    { type: 'command/run', data: { rawInput: null } },
    { type: 'command/run', data: { rawInput: { toString () { throw new Error('boom') } } } },
    { type: 'command/run', data: { text: 'switch 12' } },
    { type: 'tool/result', data: { rawInput: 'switch 12' } },
  ]
  for (const event of garbage) {
    assert.doesNotThrow(() => definition.apply(state, event), `apply 不该对 ${JSON.stringify(event)} 抛错`)
  }
  // 单个坏事件之后，正常事件仍然要工作（状态没被污染）
  const after = definition.apply(state, { type: 'command/run', data: { rawInput: 'switch 7 8' } })
  assert.equal(after.productId, '7')
})

test('apply 是日志的**纯函数**：同一份日志重放出完全相同状态（状态里没有 wall-clock）', () => {
  const { definition } = makeProjection()
  const events = [
    { type: 'command/run', data: { rawInput: 'switch 12 34' } },
    { type: 'command/done', data: { rawInput: 'switch 12 34' } },
    { type: 'command/run', data: { rawInput: 'switch 12' } },
  ]
  const fold = () => events.reduce((state, event) => definition.apply(state, event), definition.init())
  assert.deepEqual(fold(), fold())
  assert.equal(fold().updatedAt, undefined, '投影状态里不能塞 wall-clock，否则重放不确定')
})

test('帮助文本走完整链路也不会污染投影状态', () => {
  const { definition } = makeProjection()
  const state = definition.init()
  const afterHelp = definition.apply(state, {
    type: 'command/done',
    data: { text: '/zentao switch [产品编号或名称] [执行编号] —— 设置本会话的默认产品/执行' },
  })
  assert.equal(afterHelp, state, '跑一次 help 不能改动会话范围')
  assert.equal(afterHelp.productId, undefined)
})

test('注册与拆除：dispose 会清空进程内上下文', () => {
  const { sessionContext, dispose } = makeProjection()
  sessionContext.set('s1', { productId: '1' })
  assert.equal(sessionContext.size(), 1)
  dispose()
  assert.equal(sessionContext.size(), 0)
})

test('没有 sessionProjections 服务时安静跳过（返回 undefined，不抛）', () => {
  assert.equal(registerZentaoProjection({ get: () => undefined }, createSessionContext()), undefined)
})

test('createSessionContext：按会话隔离，无 sessionId 时安静忽略', () => {
  const context = createSessionContext()
  context.set('s1', { productId: '1', executionId: '2' })
  context.set('s2', { productId: '9' })
  context.set(undefined, { productId: 'x' })

  assert.equal(context.get('s1').productId, '1')
  assert.equal(context.get('s2').productId, '9')
  assert.equal(context.get('s3'), undefined)
  assert.equal(context.get(undefined), undefined)
  assert.equal(context.size(), 2)
  assert.ok(context.get('s1').updatedAt, '进程内上下文可以带 wall-clock（它是缓存，不是投影）')

  context.clear('s1')
  assert.equal(context.get('s1'), undefined)
  assert.equal(context.size(), 1)
  context.clear()
  assert.equal(context.size(), 0)
})

test('currentSessionId：宿主形状变化时返回 undefined，不抛', () => {
  assert.equal(currentSessionId({ get: () => undefined }), undefined)
  assert.equal(currentSessionId({ get: () => ({ currentInitiator: () => undefined }) }), undefined)
  assert.equal(currentSessionId({ get: () => ({ currentInitiator: () => { throw new Error('boom') } }) }), undefined)
  assert.equal(currentSessionId({ get: () => { throw new Error('no service') } }), undefined)
  assert.equal(currentSessionId({ get: () => ({ currentInitiator: () => ({ session: { header: { id: 's1' } } }) }) }), 's1')
  assert.equal(currentSessionId({ get: () => ({ currentInitiator: () => ({ session: { id: 42 } }) }) }), '42')
})
