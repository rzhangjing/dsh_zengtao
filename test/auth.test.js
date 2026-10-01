/**
 * 凭据与取 Token 路径的离线测试。
 *
 * 为什么单独测：这条路径是**安全相关**的 —— 存错东西会把 Token 写进配置、或把密码漏进日志/结果，
 * 而这两类错误都不会抛异常、只会静默发生。断言里刻意包含：
 *   · "密码只进凭据库，不进其它任何被保存的内容"；
 *   · "换来的 Token **绝不落盘**"（只活在内存缓存里）。
 *
 * 认证模型：凭据库存【账号 + 密码】→ 用它们 `POST /tokens` 换取 Token（内存缓存）→ 请求带 `Token` 头。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNT_RECORD_ID, CREDENTIAL_RECORD_OWNER, DEFAULT_ACCOUNT_REF, DEFAULT_PASSWORD_REF,
  PASSWORD_RECORD_ID, TOKEN_TTL_MS, accountRecordKey, createTokenSource, describeAuth,
  passwordRecordKey, registerAuthorizationFlow, resolveAccount, resolvePassword,
  saveAndVerifyCredentials, saveCredential,
} from '../src/auth.js'
import { createService } from '../src/service.js'
import { KeyedQueue } from '../src/domain/locks.js'
import { createFakeTransport, createMemoryStore, fakeConfig } from './helpers.js'

/** 假凭据服务（形状对齐已核验的 ctx.credentials 接口）。 */
function makeCredentials ({ refValue, record, writable = true } = {}) {
  const state = { refValue, record }
  const calls = { set: [], unset: [], modifyRecord: [] }
  return {
    calls,
    state,
    async resolve () {
      return state.refValue === undefined ? undefined : { value: state.refValue, source: 'store' }
    },
    async describe () {
      return { configured: state.refValue !== undefined, writable }
    },
    async set (ref, value) {
      if (!writable) throw new Error('read-only source shadows this reference')
      calls.set.push({ ref, value })
      state.refValue = value
    },
    async unset () { state.refValue = undefined },
    async readRecord () { return state.record },
    async describeRecord () { return { configured: Boolean(state.record), writable } },
    async listRecords () { return [] },
    async modifyRecord (key, mutate) {
      const next = await mutate(state.record)
      calls.modifyRecord.push({ key, next })
      state.record = next
      return next
    },
    async deleteRecord () { state.record = undefined },
  }
}

/**
 * 假 ctx：真实 Cordis 里服务既能 `ctx.get('credentials')` 取、也能 `ctx.credentials` 取，
 * 插件两种写法都用到了，所以这里用 Proxy 同时支持。
 */
const ctxWith = (credentials, extra = {}) => {
  const services = { credentials, ...extra }
  return new Proxy({
    get: (name) => services[name],
  }, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && services[prop] !== undefined) return services[prop]
      return undefined
    },
  })
}

/* ─────────────── 账号/密码解析 ─────────────── */

test('resolveAccount / resolvePassword：优先取引用值', async () => {
  const credentials = makeCredentials({ refValue: 'from-ref' })
  const config = { accountRef: 'ZENTAO_ACCOUNT', passwordRef: 'ZENTAO_PASSWORD' }
  assert.equal(await resolveAccount(ctxWith(credentials), config), 'from-ref')
  assert.equal(await resolvePassword(ctxWith(credentials), config), 'from-ref')
})

test('解析：引用值为空时回落到凭据记录（授权流写的就是记录）', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'rec-user', password: 'rec-pass' } } })
  assert.equal(await resolveAccount(ctxWith(credentials), {}), 'rec-user')
  assert.equal(await resolvePassword(ctxWith(credentials), {}), 'rec-pass')
})

test('解析：两者都没有时返回 undefined（由上层抛 AUTH_REQUIRED）', async () => {
  const credentials = makeCredentials({})
  assert.equal(await resolveAccount(ctxWith(credentials), {}), undefined)
  assert.equal(await resolvePassword(ctxWith(credentials), {}), undefined)
})

test('解析：没有凭据服务时退回进程环境变量（极简组合的兜底）', async () => {
  const previousAccount = process.env.ZENTAO_ACCOUNT
  const previousPassword = process.env.ZENTAO_PASSWORD
  process.env.ZENTAO_ACCOUNT = 'env-user'
  process.env.ZENTAO_PASSWORD = 'env-pass'
  try {
    assert.equal(await resolveAccount({ get: () => undefined }, {}), 'env-user')
    assert.equal(await resolvePassword({ get: () => undefined }, {}), 'env-pass')
  } finally {
    if (previousAccount === undefined) delete process.env.ZENTAO_ACCOUNT
    else process.env.ZENTAO_ACCOUNT = previousAccount
    if (previousPassword === undefined) delete process.env.ZENTAO_PASSWORD
    else process.env.ZENTAO_PASSWORD = previousPassword
  }
})

test('解析：凭据服务抛错时不把整条链路带崩，仍继续找记录', async () => {
  const credentials = {
    ...makeCredentials({ record: { payload: { account: 'still-here' } } }),
    async resolve () { throw new Error('bad ref name') },
  }
  assert.equal(await resolveAccount(ctxWith(credentials), { accountRef: 'BAD NAME' }), 'still-here')
})

test('自定义引用名生效（默认是 ZENTAO_ACCOUNT / ZENTAO_PASSWORD）', async () => {
  assert.equal(DEFAULT_ACCOUNT_REF, 'ZENTAO_ACCOUNT')
  assert.equal(DEFAULT_PASSWORD_REF, 'ZENTAO_PASSWORD')
  const credentials = makeCredentials({ refValue: 'v' })
  const seen = []
  credentials.resolve = async (ref) => { seen.push(ref); return { value: 'v' } }
  await resolveAccount(ctxWith(credentials), { accountRef: 'MY_ACCOUNT' })
  // 引用对象的形状由 dsh-credentials 决定，这里只断言"确实带上了配置里的名字"
  assert.match(JSON.stringify(seen), /MY_ACCOUNT/, '应当用配置里的引用名去查')
})

/* ─────────────── describeAuth ─────────────── */

test('describeAuth：只报告存在性与可写性，**永不返回凭据值**', async () => {
  const credentials = makeCredentials({ refValue: 'super-secret' })
  const info = await describeAuth(ctxWith(credentials), {})
  assert.equal(info.account.configured, true)
  assert.equal(info.password.configured, true)
  assert.doesNotMatch(JSON.stringify(info), /super-secret/, '诊断信息里不能出现凭据明文')
})

test('describeAuth：未配置时如实报未配置（而不是假装已配置）', async () => {
  const info = await describeAuth(ctxWith(makeCredentials({})), {})
  assert.equal(info.account.configured, false)
  assert.equal(info.password.configured, false)
})

/* ─────────────── saveCredential ─────────────── */

test('saveCredential：正常写入引用值，并报告写到了哪里', async () => {
  const credentials = makeCredentials({})
  const result = await saveCredential(ctxWith(credentials), {}, 'password', 'pw-1')
  assert.equal(result.stored, 'reference')
  assert.equal(result.ref, DEFAULT_PASSWORD_REF)
  assert.equal(credentials.state.refValue, 'pw-1')
})

test('saveCredential：只读来源遮蔽引用时改写到凭据记录，并说明原因', async () => {
  const credentials = makeCredentials({ writable: false })
  const result = await saveCredential(ctxWith(credentials), {}, 'account', 'admin')
  assert.equal(result.stored, 'record')
  assert.match(result.note, /被拒/)
  assert.equal(credentials.state.record.payload.account, 'admin')
})

test('saveCredential：空值一律拒绝（空值不等于"已配置"）', async () => {
  const credentials = makeCredentials({})
  await assert.rejects(saveCredential(ctxWith(credentials), {}, 'account', '   '), /不能为空/)
  await assert.rejects(saveCredential(ctxWith(credentials), {}, 'password', undefined), /不能为空/)
})

test('saveCredential：没有凭据服务时明确报不支持，而不是静默丢弃', async () => {
  await assert.rejects(saveCredential({ get: () => undefined }, {}, 'password', 'pw'), /没有凭据服务/)
})

/* ─────────────── createTokenSource ─────────────── */

/** 造一个只实现 exchangeToken 的假 service，并记录调用次数。 */
function makeTokenService ({ token = 'tok-1', fail } = {}) {
  const calls = []
  return {
    calls,
    async exchangeToken ({ account, password }) {
      calls.push({ account, password })
      if (fail) throw fail
      return { token }
    },
  }
}

test('createTokenSource：用账号密码换 Token，并**缓存**（第二次不再换取）', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'admin', password: 'pw' } } })
  const service = makeTokenService({ token: 'tok-abc' })
  const source = createTokenSource(ctxWith(credentials), () => ({}), service)

  assert.equal(await source.get(), 'tok-abc')
  assert.equal(await source.get(), 'tok-abc')
  assert.equal(service.calls.length, 1, '第二次应当命中缓存，不该再换一次')
  assert.deepEqual(service.calls[0], { account: 'admin', password: 'pw' })
})

test('createTokenSource：invalidate() 之后会重新换取（401 的处理路径）', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'admin', password: 'pw' } } })
  const service = makeTokenService({ token: 'tok-1' })
  const source = createTokenSource(ctxWith(credentials), () => ({}), service)
  await source.get()
  source.invalidate()
  await source.get()
  assert.equal(service.calls.length, 2, '失效后必须重新换取')
})

test('createTokenSource：并发请求只换一次（in-flight 去重）', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'a', password: 'p' } } })
  let release
  let calls = 0
  const service = {
    async exchangeToken () {
      calls += 1
      await new Promise((resolve) => { release = resolve })
      return { token: 'tok-slow' }
    },
  }
  const source = createTokenSource(ctxWith(credentials), () => ({}), service)
  const first = source.get()
  const second = source.get()
  // 换取的异步链要先跑起来（凭据解析是异步的），release 才被赋值
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1, '并发时只该发起一次换取')
  release()
  assert.deepEqual(await Promise.all([first, second]), ['tok-slow', 'tok-slow'])
  assert.equal(calls, 1, '两个调用方共用同一次换取的结果')
})

test('createTokenSource：缺账号或缺密码时抛 AUTH_REQUIRED，并给出可操作提示', async () => {
  const credentials = makeCredentials({})
  const service = makeTokenService({})
  const source = createTokenSource(ctxWith(credentials), () => ({}), service)
  await assert.rejects(source.get(), (error) => {
    assert.equal(error.code, 'AUTH_REQUIRED')
    assert.match(error.message, /账号或密码/)
    assert.match(error.hint, /设置页/)
    assert.equal(service.calls.length, 0, '不该在缺凭据时发请求')
    return true
  })
})

test('createTokenSource：禅道没返回 token 时报 AUTH_REQUIRED（账号密码错/未开 API）', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'a', password: 'p' } } })
  const source = createTokenSource(ctxWith(credentials), () => ({}), { async exchangeToken () { return {} } })
  await assert.rejects(source.get(), (error) => {
    assert.equal(error.code, 'AUTH_REQUIRED')
    assert.match(error.message, /没有返回 API Token/)
    return true
  })
})

test('createTokenSource：verify() 强制重换一次，并只报长度（不把 Token 交出去）', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'a', password: 'p' } } })
  const service = makeTokenService({ token: 'tok-verify' })
  const source = createTokenSource(ctxWith(credentials), () => ({}), service)
  await source.get()
  const verified = await source.verify()
  assert.deepEqual(verified, { ok: true, tokenLength: 'tok-verify'.length })
  assert.equal(service.calls.length, 2, 'verify 必须真的重新换一次')
  assert.doesNotMatch(JSON.stringify(verified), /tok-verify/, 'verify 的结果里不能带 Token 本体')
})

test('Token 缓存有 TTL 常量（实测禅道不给有效期，只能保守定时 + 401 重换）', () => {
  assert.equal(typeof TOKEN_TTL_MS, 'number')
  assert.ok(TOKEN_TTL_MS > 0)
})

/* ─────────────── saveAndVerifyCredentials ─────────────── */

test('saveAndVerifyCredentials：账号与密码写进凭据库并验证一次 —— **Token 不落盘**', async () => {
  const credentials = makeCredentials({})
  const service = makeTokenService({ token: 'tok-xyz' })
  const source = createTokenSource(ctxWith(credentials), () => ({}), service)
  const result = await saveAndVerifyCredentials(
    ctxWith(credentials), {}, source,
    { account: 'admin', password: 'super-secret-password' },
  )
  assert.equal(result.verified.ok, true)
  assert.equal(result.verified.tokenLength, 'tok-xyz'.length)
  assert.deepEqual(result.saved.map((item) => item.kind).sort(), ['account', 'password'])

  // **密码只应出现在凭据写入里**；换来的 Token 与密码都不能出现在别处
  const written = JSON.stringify({ calls: credentials.calls })
  assert.match(written, /super-secret-password/, '密码应当被写进凭据库')
  assert.doesNotMatch(JSON.stringify(result), /super-secret-password/, '结果里不能带密码')
  assert.doesNotMatch(JSON.stringify(result), /tok-xyz/, '结果里不能带 Token 本体')
  assert.doesNotMatch(written, /tok-xyz/, 'Token 不该被写进凭据库（只在内存缓存）')
})

test('saveAndVerifyCredentials：两者都不给时前置拒绝', async () => {
  const credentials = makeCredentials({})
  const source = createTokenSource(ctxWith(credentials), () => ({}), makeTokenService({}))
  await assert.rejects(
    saveAndVerifyCredentials(ctxWith(credentials), {}, source, {}),
    /需要提供账号或密码/,
  )
})

/* ─────────────── 授权流 ─────────────── */

test('授权流：账号与密码各一条，方法 id 与文案正确，且 key 指向对应凭据记录', () => {
  const flows = []
  const ctx = { get: (name) => (name === 'authorization' ? { registerFlow: (flow) => { flows.push(flow); return () => {} } } : undefined) }
  const dispose = registerAuthorizationFlow(ctx, { label: '本机禅道' })
  assert.equal(typeof dispose, 'function', '应当返回聚合 disposer（卸载时能拆掉）')
  assert.equal(flows.length, 2)
  const byId = Object.fromEntries(flows.map((flow) => [flow.methods[0].id, flow]))
  assert.deepEqual(byId.password.key, passwordRecordKey())
  assert.deepEqual(byId.account.key, accountRecordKey())
  assert.match(byId.password.label, /本机禅道/)
  assert.doesNotThrow(() => dispose())
})

test('授权流：密码那条在 resolve 前先提交凭据记录（否则 NOT_COMMITTED）', async () => {
  const credentials = makeCredentials({})
  const flows = []
  const ctx = ctxWith(credentials, {
    authorization: { registerFlow: (flow) => { flows.push(flow); return () => {} } },
  })
  registerAuthorizationFlow(ctx, {})
  const passwordFlow = flows.find((flow) => flow.methods[0].id === 'password')
  await passwordFlow.run({ prompt: async () => 'from-prompt' })
  assert.equal(credentials.state.record.payload.password, 'from-prompt')
  assert.equal(credentials.calls.modifyRecord.length, 1, '必须在流程内提交记录')
})

test('凭据记录键：owner/id 固定（单站点），且真实形态是**字符串**（品牌只在类型层面）', () => {
  assert.equal(CREDENTIAL_RECORD_OWNER, 'dsh-plugin-zentao')
  assert.equal(ACCOUNT_RECORD_ID, 'account')
  assert.equal(PASSWORD_RECORD_ID, 'password')
  // 真实实现 credentialKey(scope, id) → brandString(`${scope}/${id}`)，而 brandString 是恒等函数。
  // 授权服务用 `Map` 按值查 flow，所以这里必须是**原始字符串**（若是对象就会按引用比较，真机行为不同）。
  assert.equal(typeof accountRecordKey(), 'string')
  assert.equal(accountRecordKey(), `${CREDENTIAL_RECORD_OWNER}/${ACCOUNT_RECORD_ID}`)
  assert.equal(passwordRecordKey(), `${CREDENTIAL_RECORD_OWNER}/${PASSWORD_RECORD_ID}`)
})

/* ─────────────── service.exchangeToken（换 Token 的真实请求形状）─────────────── */

function makeExchangeService (routes) {
  const fake = createFakeTransport(routes)
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0 }),
    getToken: async () => 'unused',
    logger: () => {},
  })
  return { service, fake }
}

test('exchangeToken：按已核验形状 POST /tokens（带 /api.php/v1 前缀），取出 token', async () => {
  const { service, fake } = makeExchangeService({
    'POST /tokens': ({ body }) => ({ json: { token: `tok-for-${body.account}` } }),
  })
  const result = await service.exchangeToken({ account: 'admin', password: 'pw' })
  assert.deepEqual(result, { token: 'tok-for-admin' })
  const call = fake.callsTo('POST /tokens')[0]
  assert.deepEqual(call.body, { account: 'admin', password: 'pw' })
  assert.equal(call.pathname, '/api.php/v1/tokens', '认证请求也必须带 API 前缀')
})

test('exchangeToken：禅道没返回 token 时报 VALIDATION（账号密码错误/未开 API）', async () => {
  const { service } = makeExchangeService({
    'POST /tokens': () => ({ json: { error: 'wrong password' } }),
  })
  await assert.rejects(service.exchangeToken({ account: 'a', password: 'b' }), (error) => {
    assert.equal(error.code, 'VALIDATION')
    assert.match(error.message, /没有返回 token/)
    return true
  })
})

test('exchangeToken：缺少账号或密码时前置拒绝', async () => {
  const { service, fake } = makeExchangeService({})
  await assert.rejects(service.exchangeToken({ account: '', password: 'x' }), /需要 account 与 password/)
  await assert.rejects(service.exchangeToken({ account: 'x', password: '' }), /需要 account 与 password/)
  assert.equal(fake.calls.length, 0, '不该发出任何请求')
})

/* ─────────────── 401 会丢掉缓存（端到端：service + tokenSource）─────────────── */

test('端到端：收到 401 后 tokenSource 失效，下一次调用会重新换取', async () => {
  const credentials = makeCredentials({ record: { payload: { account: 'admin', password: 'pw' } } })
  const fake = createFakeTransport({
    'POST /tokens': ({ body }) => ({ json: { token: `tok-${body.account}-${Math.random()}` } }),
    'GET /products': (() => {
      let first = true
      return () => {
        if (first) { first = false; return { status: 401, json: { error: 'token expired' } } }
        return { json: { page: 1, total: 0, limit: 20, products: [] } }
      }
    })(),
  })
  let exchanges = 0
  const service = createService({
    transport: fake.transport,
    store: createMemoryStore(),
    locks: new KeyedQueue(),
    getConfig: () => fakeConfig({ cacheTtlSeconds: 0 }),
    getToken: () => source.get(),
    onAuthFailure: () => source.invalidate(),
    logger: () => {},
  })
  const source = createTokenSource(ctxWith(credentials), () => fakeConfig(), {
    async exchangeToken ({ account, password }) {
      exchanges += 1
      return service.exchangeToken({ account, password })
    },
  })

  await assert.rejects(service.query({ entity: 'product', page: 1, limit: 5 }), (error) => {
    assert.equal(error.code, 'AUTH_EXPIRED')
    return true
  })
  // 缓存被丢掉之后，第二次调用会自动重换 Token 并成功
  const second = await service.query({ entity: 'product', page: 1, limit: 5 })
  assert.equal(second.serverTotal, 0)
  assert.equal(exchanges, 2, '401 之后必须重新换取一次 Token')
})
