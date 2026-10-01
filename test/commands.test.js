/**
 * `/zentao` 命令的离线测试。
 *
 * 重点是 `/zentao login`：它把"账号密码登录"接到 DSH 授权服务上，而那条接线的**参数形状**
 * 曾经写错（`begin(key)` 而不是 `begin({ key })`），真机报的是：
 *
 *     [NO_FLOW] no authorization flow is registered for "undefined"
 *
 * 原因：`dsh-authorization/lib/index.js` 的 `begin(request)` 第一行是 `const { key } = request`，
 * 传裸 key 会让 `request.key` 变成 undefined。这里把这个形状钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { accountRecordKey, passwordRecordKey, registerAuthorizationFlow } from '../src/auth.js'
import { registerCommands } from '../src/commands.js'
import { createFakeTransport, createMemoryStore, fakeConfig } from './helpers.js'
import { createService } from '../src/service.js'
import { KeyedQueue } from '../src/domain/locks.js'

/** 记录 begin/registerFlow 的假授权服务，并复用真实实现的核心行为（key → flow 映射）。 */
function makeAuthorization ({ decline = false } = {}) {
  const flows = new Map()
  const beginCalls = []
  return {
    flows,
    beginCalls,
    registerFlow (flow) {
      if (flows.has(flow.key)) throw new Error(`duplicate flow for ${flow.key}`)
      flows.set(flow.key, flow)
      return () => { flows.delete(flow.key) }
    },
    async begin (request) {
      beginCalls.push(request)
      // 真实实现就是 `const { key } = request` —— 这里刻意照抄，才能在测试里复现该缺陷
      const { key } = request ?? {}
      const flow = flows.get(key)
      if (flow === undefined) {
        const error = new Error(`no authorization flow is registered for "${key}"`)
        error.code = 'NO_FLOW'
        throw error
      }
      if (decline) return { status: 'cancelled' }
      await flow.run({
        prompt: async () => (flow.methods[0].id === 'password' ? 'pw-from-prompt' : 'admin'),
        notify: () => {},
        signal: undefined,
      })
      return { status: 'authorized' }
    },
  }
}

function makeEnv ({ authorization, credentials } = {}) {
  const fake = createFakeTransport({ 'POST /tokens': () => ({ json: { token: 'tok-1' } }) })
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0 }),
    getToken: async () => 'tok-1',
    logger: () => {},
  })
  const commands = []
  const services = {
    commands: { register: (command) => { commands.push(command); return () => {} } },
    authorization,
    credentials,
  }
  // 真实 Cordis 里服务既能 `ctx.get('credentials')` 取、也能 `ctx.credentials` 取；
  // 授权流的 run() 用的是后者，所以这里用 Proxy 同时支持（否则测试会因为桩的缺口而误报）。
  const ctx = new Proxy({ get: (name) => services[name] }, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && services[prop] !== undefined) return services[prop]
      return undefined
    },
  })
  const tokenSource = { async verify () { return { ok: true, tokenLength: 5 } } }
  // 与真实装配一致：授权流是在 apply() 里注册的，命令只负责 begin()。
  // 少了这一步，`/zentao login` 会因为"没有任何 flow"而 NO_FLOW（第一版测试就漏了它）。
  if (authorization !== undefined) registerAuthorizationFlow(ctx, { label: '测试禅道' })
  registerCommands(ctx, service, () => fakeConfig({ cacheTtlSeconds: 0 }), { get: () => undefined }, tokenSource)
  return commands[0]
}

test('/zentao login：**begin 必须收到 { key } 对象**（传裸 key 会 NO_FLOW "undefined"）', async () => {
  const authorization = makeAuthorization()
  const records = []
  const credentials = {
    async modifyRecord (key, mutate) { records.push(key); return mutate(undefined) },
  }
  const command = makeEnv({ authorization, credentials })
  const result = await command.handler({ agent: undefined, rawInput: 'login' })

  assert.equal(result.kind, 'success', `应登录成功，实际：${result.text}`)
  assert.equal(authorization.beginCalls.length, 2, '账号与密码各一次授权')

  for (const request of authorization.beginCalls) {
    assert.equal(typeof request, 'object', 'begin 的参数必须是对象')
    assert.notEqual(request.key, undefined, 'begin 的 key 不能是 undefined（否则真机会报 NO_FLOW "undefined"）')
  }
  const keys = authorization.beginCalls.map((request) => request.key).sort()
  assert.deepEqual(keys, [accountRecordKey(), passwordRecordKey()].sort(),
    '传的 key 必须与注册的凭据记录键一致')

  // 两条流都真的写了凭据记录
  assert.deepEqual(records.map((key) => String(key)).sort(), [String(accountRecordKey()), String(passwordRecordKey())].sort())
  assert.match(result.text, /密码已保存/)
  assert.match(result.text, /账号已保存/)
  assert.match(result.text, /换取 API Token 成功/)
})

test('/zentao login：人在授权里点了"不"（cancelled）时如实报未完成，不谎报成功', async () => {
  const authorization = makeAuthorization({ decline: true })
  const command = makeEnv({ authorization, credentials: { async modifyRecord () {} } })
  const result = await command.handler({ agent: undefined, rawInput: 'login' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /密码授权未完成（cancelled）/)
})

test('/zentao login：拒绝把密码写在命令里（命令文本会进会话记录）', async () => {
  const authorization = makeAuthorization()
  const command = makeEnv({ authorization, credentials: { async modifyRecord () {} } })
  const result = await command.handler({ agent: undefined, rawInput: 'login admin MySecretPassword' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /不要在命令里直接写密码/)
  assert.doesNotMatch(result.text, /MySecretPassword/, '错误信息里也不能回显用户输入的密码')
  assert.equal(authorization.beginCalls.length, 0, '这种用法不该启动任何授权流程')
})

test('/zentao login：没有授权服务时给出可操作的替代路径', async () => {
  const command = makeEnv({ authorization: undefined, credentials: undefined })
  const result = await command.handler({ agent: undefined, rawInput: 'login' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /设置页/)
  assert.match(result.text, /ZENTAO_ACCOUNT/)
})

test('/zentao 状态：如实显示账号/密码是否已配置（不显示值本身）', async () => {
  const authorization = makeAuthorization()
  const credentials = {
    async describe () { return { configured: true, writable: true } },
    async describeRecord () { return { configured: false, writable: true } },
    async resolve () { return { value: 'super-secret' } },
    async readRecord () { return undefined },
  }
  const command = makeEnv({ authorization, credentials })
  const result = await command.handler({ agent: undefined, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /账号：已配置/)
  assert.match(result.text, /密码：已配置/)
  assert.doesNotMatch(result.text, /super-secret/, '状态里不能带凭据值')
})

test('/zentao help：列出 login 并说明密码不进命令文本', async () => {
  const command = makeEnv({ authorization: makeAuthorization() })
  const result = await command.handler({ agent: undefined, rawInput: 'help' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\/zentao login/)
  assert.match(result.text, /密码不会出现在命令文本里/)
})

/* ─────────────── /zentao switch：用户看不到产品编号的痛点 ─────────────── */

/** 造一个用假 transport 提供产品列表的 env（switch 需要 query + get）。 */
function makeSwitchEnv (products) {
  const routes = {
    'GET /products': () => ({ json: { page: 1, total: products.length, limit: 20, products } }),
  }
  for (const product of products) {
    routes[`GET /products/${product.id}`] = () => ({ json: product })
  }
  const fake = createFakeTransport(routes)
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0 }),
    getToken: async () => 'tok-1',
    logger: () => {},
  })
  const commands = []
  const sessions = new Map()
  const sessionContext = {
    get: (id) => sessions.get(id),
    set: (id, value) => sessions.set(id, value),
  }
  const ctx = { get: (name) => (name === 'commands' ? { register: (command) => { commands.push(command); return () => {} } } : undefined) }
  registerCommands(ctx, service, () => fakeConfig({ cacheTtlSeconds: 0 }), sessionContext,
    { async verify () { return { ok: true, tokenLength: 5 } } })
  return { command: commands[0], sessions, fake }
}

const PRODUCTS = [
  { id: 1, title: 'DSH插件校准测试' },
  { id: 4, title: '内部工具' },
  { id: 9, title: '内部工具（旧）' },
]

test('/zentao switch 不带参数：**要把产品编号列出来**（用户看不到 id 就是这个痛点）', async () => {
  const { command } = makeSwitchEnv(PRODUCTS)
  const result = await command.handler({ agent: undefined, rawInput: 'switch' })
  assert.equal(result.kind, 'success', '不带参数不该报错 —— 它应该是一份"产品与编号"清单')
  assert.match(result.text, /#1\s+DSH插件校准测试/)
  assert.match(result.text, /#4\s+内部工具/)
  assert.match(result.text, /#9\s+内部工具（旧）/)
  assert.match(result.text, /用法：\/zentao switch <产品编号或名称>/, '要顺手给出下一步怎么用')
})

test('/zentao switch 支持用**名称**设置（精确匹配优先）', async () => {
  const { command, sessions } = makeSwitchEnv(PRODUCTS)
  const result = await command.handler({ agent: undefined, rawInput: 'switch DSH插件校准测试 7' })
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(sessions.get(undefined), { productId: '1', executionId: '7', productTitle: 'DSH插件校准测试' })
})

test('/zentao switch 名称不唯一时**列出候选**而不是猜一个', async () => {
  const { command } = makeSwitchEnv(PRODUCTS)
  // 精确匹配「内部工具」→ 直接命中 #4（不会因为"内部工具（旧）"也包含它而歧义）
  const exact = await command.handler({ agent: undefined, rawInput: 'switch 内部工具' })
  assert.equal(exact.kind, 'success', exact.text)
  assert.match(exact.text, /#4/)

  // 只有部分匹配且命中多个 → 必须让用户指明
  const partial = await command.handler({ agent: undefined, rawInput: 'switch 工具' })
  assert.equal(partial.kind, 'error', '多个候选时应要求用户指明，而不是随便选一个')
  assert.match(partial.text, /匹配到 2 个产品/)
  assert.match(partial.text, /#4/)
  assert.match(partial.text, /#9/)
})

test('/zentao switch 名称找不到时：报错并**列出可用产品**', async () => {
  const { command } = makeSwitchEnv(PRODUCTS)
  const result = await command.handler({ agent: undefined, rawInput: 'switch 不存在的产品' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有找到名称匹配/)
  assert.match(result.text, /#1\s+DSH插件校准测试/, '报错时也要把可选项给出来')
})

test('/zentao switch 编号不存在时：报错并列出可用产品（而不是只说"读不到"）', async () => {
  const { command } = makeSwitchEnv(PRODUCTS)
  const result = await command.handler({ agent: undefined, rawInput: 'switch 999' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无法读取产品 #999/)
  assert.match(result.text, /#1\s+DSH插件校准测试/)
})

test('/zentao switch：站点里一个产品都没有时给出可操作的话，而不是空白', async () => {
  const { command } = makeSwitchEnv([])
  const result = await command.handler({ agent: undefined, rawInput: 'switch' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /没有可用的产品/)
})

test('USAGE：switch 的说明要写明"不带参数会列出所有产品与编号"', async () => {
  const { command } = makeSwitchEnv(PRODUCTS)
  const result = await command.handler({ agent: undefined, rawInput: 'help' })
  assert.match(result.text, /不带参数会列出所有产品与编号/)
})
