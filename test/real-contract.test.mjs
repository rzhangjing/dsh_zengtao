/**
 * 对**真实包**的契约校验（默认跳过）。
 *
 * 为什么需要它：`test/stubs/dsh.mjs` 是按文档**推测**出来的真实契约。若推测有偏差
 * （真实 `defineTool` 要求更多字段、真实 `schemastery` 不接受某种写法…），插件会在
 * 真机上**加载即失败** —— 而这正是我在这个环境里无法靠"安装一次"发现的。
 *
 * 这个文件用真实的 `schemastery` / `defineTool` / `defineDomain` / `credentialRef`
 * 去撞本插件的**真实定义**，因此能在安装之前回答："拿到真机上会不会加载失败？"
 *
 * 运行方式（先抽取真实包，再指定目录）：
 *   DSH_REAL_MODULES=<抽取目录> node --import ./test/register-real.mjs --test test/real-contract.test.mjs
 *
 * 抽取清单：`@deepseek-ai/{cordis,cosmokit,dsh-brand,dsh-tools,dsh-credentials,dsh-storage,dsh-storage-domain,schemastery}`
 * 与 `zod` 的 `lib/**`（含 `package.json`）。
 * 未设置 `DSH_REAL_MODULES` 时全部跳过，因此 `npm test` 保持自包含。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const REAL = process.env.DSH_REAL_MODULES
const skip = REAL ? false : '需要 DSH_REAL_MODULES 指向抽取出来的真实包目录'

/** 假 Cordis 上下文：服务既可从 ctx.get 取，也可按属性取（真实宿主两种都支持）。 */
function makeCtx () {
  const rec = { tools: [], listeners: [], commands: [], skills: [], sections: [], effects: [], injects: [] }
  const services = {
    tools: { register: (tool) => { rec.tools.push(tool); return () => {} } },
    commands: { register: (command) => { rec.commands.push(command); return () => {} } },
    skills: { register: (skill) => { rec.skills.push(skill); return () => {} } },
    systemPrompt: {
      section: (section) => { rec.sections.push(section); return () => {} },
      variable: () => () => {},
    },
    sessionProjections: { register: () => () => {} },
    authorization: { registerFlow: () => () => {} },
  }
  const ctx = new Proxy({
    get: (name) => services[name],
    on: (event, listener) => { rec.listeners.push({ event, listener }); return () => {} },
    effect: (fn, label) => {
      const dispose = fn()
      rec.effects.push({ label, dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (deps, callback) => { rec.injects.push({ deps, callback }); return () => {} },
  }, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && services[prop] !== undefined) return services[prop]
      return undefined
    },
  })
  return { ctx, rec }
}

test('真实 schemastery：能构建并解析本插件的 Config，且 volatile 字段真的是活引用', { skip }, async () => {
  const schemastery = (await import('@deepseek-ai/schemastery')).default
  assert.equal(typeof schemastery?.object, 'function', '应能取到真实的 schemastery')
  const { Config } = await import('../src/config.js')
  assert.equal(typeof Config, 'function', 'schemastery 的 schema 应当是**可调用的校验器**')

  const parsed = Config({ baseURL: 'https://zt.example.com/' })
  assert.equal(typeof parsed.baseURL?.get, 'function', 'volatile 字段必须是带 .get() 的活引用')
  assert.equal(parsed.baseURL.get(), 'https://zt.example.com/')
  // 插件到处依赖"默认值也能通过引用读到"
  assert.equal(parsed.writePolicy.get(), 'confirm')
  assert.equal(parsed.label.get(), '禅道')
  assert.equal(parsed.allowUnverifiedWrites.get(), false)
  assert.equal(parsed.dialect.get(), 'auto')
  assert.equal(parsed.maxPageSize.get(), 50)
})

test('真实 schemastery：除 baseURL 外**每个**字段都必须有可用的默认值', { skip }, async () => {
  const { Config, snapshotConfig } = await import('../src/config.js')
  const snapshot = snapshotConfig(Config({ baseURL: 'https://zt.example.com' }))
  assert.equal(snapshot.baseURL, 'https://zt.example.com')
  assert.equal(snapshot.writePolicy, 'confirm')

  // 设计原则（§3）：除用户必须自己填的 baseURL 外，所有字段都要有可用默认值 ——
  // 因为一层 patch 会整体替换 config，用户升级时不该被要求重述任何字段。
  const withoutDefault = Object.entries(snapshot)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key)
  assert.deepEqual(withoutDefault, [], `这些字段没有默认值，用户升级时会被迫重述：${withoutDefault.join(', ')}`)
})

test('真实 defineTool：接受本插件的 5 个工具定义（走真实 apply()）', { skip }, async () => {
  const toolsModule = await import('@deepseek-ai/dsh-tools')
  assert.equal(typeof toolsModule.defineTool, 'function', '应能取到真实的 defineTool')

  const { Config } = await import('../src/config.js')
  const plugin = await import('../index.js')
  const { ctx, rec } = makeCtx()
  plugin.apply(ctx, Config({ baseURL: 'https://zt.example.com' }))

  assert.deepEqual(rec.tools.map((tool) => tool.name), [
    'zentao_query', 'zentao_get', 'zentao_my', 'zentao_write', 'zentao_board',
  ])
  // 真实 defineTool 接受的返回值必须仍是"可注册的定义"
  for (const tool of rec.tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} 的定义应保留 execute`)
  }
  assert.equal(rec.listeners.length, 1, '应注册一个 tools/pre-execute 门禁监听器')
  assert.equal(rec.commands.length, 1, '应注册 /zentao 命令')
})

test('真实 defineDomain + 真实 zod：接受本插件的域声明（store.js 在 import 时即执行）', { skip }, async () => {
  const storageDomain = await import('@deepseek-ai/dsh-storage-domain')
  assert.equal(typeof storageDomain.defineDomain, 'function')
  assert.equal(typeof storageDomain.domainTable, 'function')
  const store = await import('../src/store.js')
  assert.equal(store.zentaoDomain.name, 'zentao')
  assert.equal(store.zentaoDomain.version, 1)
  assert.deepEqual(Object.keys(store.zentaoDomain.tables).sort(), ['entities', 'idempotency', 'probe'])
  // 真实 defineDomain 会在模块加载时校验该策略（取值只能是 'backup-and-skip'），
  // 所以这条断言同时证明了"声明合法"与"策略没被误改"。
  assert.equal(store.zentaoDomain.invalidRecords, 'backup-and-skip')
})

test('真实 credentialRef / credentialKey：接受本插件的引用名与记录键', { skip }, async () => {
  const credentials = await import('@deepseek-ai/dsh-credentials')
  assert.equal(typeof credentials.credentialRef, 'function')
  assert.equal(typeof credentials.credentialKey, 'function')
  const auth = await import('../src/auth.js')

  assert.ok(credentials.credentialRef('ZENTAO_ACCOUNT'), 'credentialRef 应接受 ZENTAO_ACCOUNT')
  assert.ok(credentials.credentialRef('ZENTAO_PASSWORD'), 'credentialRef 应接受 ZENTAO_PASSWORD')
  assert.deepEqual(
    auth.passwordRecordKey(),
    credentials.credentialKey(auth.CREDENTIAL_RECORD_OWNER, auth.PASSWORD_RECORD_ID),
    '密码记录键应与真实实现构造的一致',
  )
  assert.deepEqual(
    auth.accountRecordKey(),
    credentials.credentialKey(auth.CREDENTIAL_RECORD_OWNER, auth.ACCOUNT_RECORD_ID),
    '账号记录键应与真实实现构造的一致',
  )
})

test('真实 defineTool：一个**故意写错**的定义会被拒绝（确认这个校验真的在起作用）', { skip }, async () => {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  let rejected = false
  try {
    defineTool({ name: 'x', description: 'd', parameters: {}, output: {} })
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, '缺少 execute/output.render 的定义必须被真实 defineTool 拒绝；' +
    '若这里没被拒绝，说明本文件的其余断言其实是空转')
})

/* ─────────── 参数 DSL → 模型看到的 JSON Schema ─────────── */

/** 跑一遍真实 apply()，拿到真实 defineTool 编译后的工具定义。 */
async function compiledTools () {
  const { Config } = await import('../src/config.js')
  const plugin = await import('../index.js')
  const { ctx, rec } = makeCtx()
  plugin.apply(ctx, Config({ baseURL: 'https://zt.example.com' }))
  return Object.fromEntries(rec.tools.map((tool) => [tool.name, tool]))
}

test('真实工具契约：参数 DSL 投影成对象 JSON Schema，required 与声明一致', { skip }, async () => {
  const tools = await compiledTools()
  const expectedRequired = {
    zentao_query: ['entity'],
    zentao_get: ['entity', 'id'],
    zentao_my: [],
    zentao_write: ['action', 'entity'],
    zentao_board: ['scope', 'id'],
  }
  for (const [name, required] of Object.entries(expectedRequired)) {
    const tool = tools[name]
    assert.ok(tool, `缺少工具 ${name}`)
    assert.equal(tool.parameters.type, 'object', `${name} 的参数必须投影成对象 schema`)
    assert.deepEqual(
      [...(tool.parameters.required ?? [])].sort(),
      [...required].sort(),
      `${name} 的 required 与声明不一致`,
    )
  }
})

test('真实工具契约：作者侧的 `json` 节点不得泄漏进模型看到的 JSON Schema', { skip }, async () => {
  const tools = await compiledTools()
  for (const [name, tool] of Object.entries(tools)) {
    for (const [key, property] of Object.entries(tool.parameters.properties ?? {})) {
      assert.notEqual(
        property.type, 'json',
        `${name}.${key} 的 type 仍是 'json' —— 原始 JSON Schema 没有这个类型，说明它没被编译成注解式 schema`,
      )
    }
  }
  // payload / bulk 走的就是 json DSL，它们必须仍然存在（只是类型变了）
  assert.ok(tools.zentao_write.parameters.properties.payload, 'write 应有 payload 参数')
  assert.ok(tools.zentao_write.parameters.properties.bulk, 'write 应有 bulk 参数')
})

test('真实工具契约：参数校验真的会拒绝非法参数（不是空转）', { skip }, async () => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const tools = await compiledTools()

  // 合法参数：必须是**零**违规
  assert.deepEqual(
    validateJsonSchemaValue(tools.zentao_query.parameters, { entity: 'task' }, ''),
    [],
    '合法参数不应产生违规',
  )
  assert.deepEqual(
    validateJsonSchemaValue(tools.zentao_get.parameters, { entity: 'bug', id: '501' }, ''),
    [],
  )
  assert.deepEqual(
    validateJsonSchemaValue(tools.zentao_board.parameters, { scope: 'execution', id: '13' }, ''),
    [],
  )

  // 非法参数：必须被拒绝
  assert.ok(
    validateJsonSchemaValue(tools.zentao_query.parameters, { entity: '不存在的实体' }, '').length > 0,
    '枚举外的实体名必须被拒绝',
  )
  assert.ok(
    validateJsonSchemaValue(tools.zentao_query.parameters, {}, '').length > 0,
    '缺少必填参数必须被拒绝',
  )
  assert.ok(
    validateJsonSchemaValue(tools.zentao_board.parameters, { scope: '迭代', id: '13' }, '').length > 0,
    '中文枚举值必须被拒绝（工具标识符刻意保持 ASCII）',
  )
})

test('真实工具契约：参数 schema 能渲染成 TS（说明模型/SDK 侧看得懂）', { skip }, async () => {
  const { jsonSchemaToTs } = await import('@deepseek-ai/dsh-tools')
  const tools = await compiledTools()
  const ts = jsonSchemaToTs(tools.zentao_write.parameters)
  assert.equal(typeof ts, 'string')
  assert.match(ts, /action/, 'TS 渲染里应出现参数名')
  assert.match(ts, /entity/)
})

/* ─────────── 补丁：用**真实装载器**验证（最接近"能不能装上"的检查） ─────────── */

test('真实补丁装载：loadOverlayPatches 能解析本插件的 cordis.patch.yml', { skip }, async () => {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
  const patchFile = path.join(root, 'cordis.patch.yml')

  // loadOverlayPatches 正是为 bundle 的 cordis.patch.yml 准备的：真实解析 + 校验，失败即抛
  const patches = boot.loadOverlayPatches('dsh', patchFile)
  assert.ok(Array.isArray(patches), '补丁应解析成一个列表')
  assert.equal(patches.length, 1)
  assert.ok(Array.isArray(patches[0].insert), 'insert 必须是**序列**（真实 loader 会 spread 它）')
  assert.equal(patches[0].insert[0].id, 'zentao')
  assert.ok(fs.existsSync(patchFile))
})

test('真实补丁应用：composeEntries 真的把本插件插入组合，且**零警告**', { skip }, async () => {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const path = await import('node:path')
  const url = await import('node:url')
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')

  const patches = boot.loadOverlayPatches('dsh', path.join(root, 'cordis.patch.yml'))
  const warnings = []
  // composeEntries 内部就是 applyEntryPatches([], layers.flat()) —— 真实插入逻辑。
  // 若 insert 写成单个映射，这里会抛 `Spread syntax requires ...iterable`。
  const rows = boot.composeEntries([patches], (message) => warnings.push(message))

  assert.deepEqual(warnings, [], '真实补丁应用不应产生任何警告（警告意味着补丁被跳过）')
  const row = rows.find((entry) => entry.id === 'zentao')
  assert.ok(row, '补丁必须真的插入 id 为 zentao 的行')
  assert.equal(row.name, '@local/dsh-plugin-zentao')
  assert.equal(row.config.writePolicy, 'confirm')
  assert.equal(row.config.dialect, 'auto')
  assert.equal(row.config.accountRef, 'ZENTAO_ACCOUNT')
    assert.equal(row.config.passwordRef, 'ZENTAO_PASSWORD')
})

test('真实补丁应用：**写成单个映射的 insert 必须被拒绝**（证明上一条不是空转）', { skip }, async () => {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const bad = path.join(os.tmpdir(), `zentao-bad-patch-${process.pid}.yml`)
  fs.writeFileSync(bad, [
    '- insert:',
    '    id: zentao',
    '    name: @local/dsh-plugin-zentao',
  ].join('\n'))
  try {
    let rejected = false
    try {
      const patches = boot.loadOverlayPatches('dsh', bad)
      try {
        boot.composeEntries([patches], () => {})
      } catch {
        rejected = true // 真实 applyEntryPatches 的 `data.push(...insert)` 抛 TypeError
      }
    } catch {
      rejected = true // 或者解析阶段就拒绝
    }
    assert.equal(rejected, true,
      'insert 写成单个映射时，真实装载器必须报错 —— 否则上一条"零警告"的通过说明不了任何事')
  } finally {
    fs.rmSync(bad, { force: true })
  }
})

test('真实 Cordis：插件能作为 Cordis 插件加载、门禁挂在**真实 waterfall** 上、卸载后清干净', { skip }, async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const url = await import('node:url')
  const pluginPath = url.pathToFileURL(
    (await import('node:path')).resolve(
      (await import('node:path')).dirname(url.fileURLToPath(import.meta.url)), '..', 'index.js')).href
  const mod = await import(pluginPath)

  /** 用**不跟踪注册**的桩服务做宿主：这样"卸载后是否清干净"完全取决于插件自己。
   *  每个策略用独立 Context —— 否则两个实例的守卫会互相短路，读出假象。 */
  async function boot (writePolicy) {
    const reg = { tools: [], commands: [], skills: [], sections: [], variables: [] }
    const drop = (arr, v) => () => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1) }
    const ctx = new Context()
    ctx.provide('tools', { register: (t) => { reg.tools.push(t); return drop(reg.tools, t) } })
    ctx.provide('commands', { register: (c) => { reg.commands.push(c); return drop(reg.commands, c) } })
    ctx.provide('skills', { register: (s) => { reg.skills.push(s); return drop(reg.skills, s) } })
    ctx.provide('systemPrompt', {
      section: (s) => { reg.sections.push(s); return drop(reg.sections, s) },
      variable: (name, resolve) => { const v = { name, resolve }; reg.variables.push(v); return drop(reg.variables, v) },
    })
    ctx.provide('credentials', { credentialRef: () => ({}), credentialKey: () => 'k' })
    ctx.provide('authorization', { registerFlow: () => () => {} })
    ctx.provide('sessionProjections', { register: () => () => {} })
    ctx.provide('storageDomain', { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) })
    const fiber = ctx.plugin(mod, { baseURL: 'http://127.0.0.1/zentao', accountRef: 'ZENTAO_ACCOUNT', passwordRef: 'ZENTAO_PASSWORD', writePolicy })
    await new Promise((r) => setTimeout(r, 200))
    return { ctx, fiber, reg }
  }

  const gate = (ctx, input) => ctx.waterfall('tools/pre-execute', { name: 'zentao_write', arguments: input }, () => Promise.resolve({ kind: 'allow' }))

  const confirmRun = await boot('confirm')
  assert.deepEqual(confirmRun.reg.tools.map((t) => t.name), [
    'zentao_query', 'zentao_get', 'zentao_my', 'zentao_write', 'zentao_board',
  ], '真框架下应注册这 5 个工具')
  assert.deepEqual(confirmRun.reg.commands.map((c) => c.name), ['zentao'])
  assert.equal(confirmRun.reg.skills.length, 1)
  assert.equal(confirmRun.reg.sections.length, 1)
  assert.equal(confirmRun.reg.variables.length, 2)
  // 真 waterfall：读工具与 dryRun 放行；真写入/删除/批量都要问
  assert.equal((await confirmRun.ctx.waterfall('tools/pre-execute', { name: 'zentao_query', arguments: {} }, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow')
  assert.equal((await gate(confirmRun.ctx, { action: 'update', entity: 'task', id: '1', dryRun: true })).kind, 'allow')
  assert.equal((await gate(confirmRun.ctx, { action: 'update', entity: 'task', id: '1', dryRun: false })).kind, 'ask')
  assert.equal((await gate(confirmRun.ctx, { action: 'delete', entity: 'task', id: '1', dryRun: false })).kind, 'ask')
  assert.equal((await gate(confirmRun.ctx, { action: 'update', entity: 'task', bulk: [{ id: '1' }, { id: '2' }], dryRun: false })).kind, 'ask')

  const readonlyRun = await boot('readonly')
  const denied = await gate(readonlyRun.ctx, { action: 'update', entity: 'task', id: '1', dryRun: false })
  assert.equal(denied.kind, 'deny', 'readonly 策略下真实写入必须被拒')
  assert.match(denied.reason, /只读|readonly/)

  // 卸载必须清干净（宿主桩服务不跟踪注册，所以这完全在考插件自己）
  await confirmRun.fiber.dispose()
  await readonlyRun.fiber.dispose()
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(confirmRun.reg.tools, [], '卸载后工具没被拆掉（HMR 重载会重复注册）')
  assert.deepEqual(confirmRun.reg.commands, [], '卸载后命令没被拆掉')
  assert.deepEqual(confirmRun.reg.skills, [], '卸载后技能没被拆掉')
  assert.deepEqual(confirmRun.reg.variables, [], '卸载后提示词变量没被拆掉')
  assert.deepEqual(confirmRun.reg.sections, [], '卸载后提示词段没被拆掉')
})

test('真实 dsh-authorization：begin 必须收 { key }，且流程必须在 resolve 前提交凭据记录', { skip }, async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { AuthorizationService } = await import('@deepseek-ai/dsh-authorization')
  const auth = await import('../src/auth.js')

  const records = new Map()
  const ctx = new Context()
  ctx.provide('credentials', {
    async modifyRecord (key, mutate) {
      const next = await mutate(records.get(key))
      records.set(key, next)
      // 真实凭据服务在写记录后会 fan out 这个事件，而授权服务**正是靠它**判定"本次尝试提交过记录"
      // （dsh-authorization/lib/index.js 的 `observed.committed`）。假服务必须照做，否则一律 NOT_COMMITTED。
      ctx.emit('credentials/record-updated', key)
      return next
    },
    async readRecord (key) { return records.get(key) },
    // 授权服务还用这个方法做第二次确认（describeRecord(key).configured）。
    async describeRecord (key) { return { configured: records.has(key), writable: true } },
  })
  ctx.plugin(AuthorizationService)
  // 服务是异步激活的（Service 生命周期）：轮询到它挂上为止
  for (let i = 0; i < 50 && (ctx.authorization ?? ctx.get('authorization')) === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const authorization = ctx.authorization ?? ctx.get('authorization')
  assert.ok(authorization, '真实授权服务应当挂到 ctx.authorization 上')

  // 用**生产路径**注册（src/auth.js 的注册函数）
  const dispose = auth.registerAuthorizationFlow(ctx, { label: '契约测试' })
  assert.equal(typeof dispose, 'function')

  // ① 错误的调用形状（裸 key）在真实实现里必然 NO_FLOW —— 这就是真机报 "undefined" 的成因
  await assert.rejects(
    authorization.begin(auth.passwordRecordKey()),
    (error) => {
      assert.equal(error.code, 'NO_FLOW')
      assert.match(error.message, /"undefined"/, '裸 key 会让 key 变成 undefined，报错文本正是用户看到的那句')
      return true
    },
  )

  // ② 正确形状：真实服务会跑流程，并把结果写进凭据记录
  const status = await authorization.begin({
    key: auth.passwordRecordKey(),
    interaction: { prompt: async () => 'pw-from-real-service', notify: () => {} },
  })
  assert.equal(status.status, 'authorized')
  assert.equal(records.get(auth.passwordRecordKey())?.payload?.password, 'pw-from-real-service',
    '流程必须真的把凭据记录提交上去（否则真实服务会以 NOT_COMMITTED 拒绝）')

  // ③ 账号那条也走一遍
  const accountStatus = await authorization.begin({
    key: auth.accountRecordKey(),
    interaction: { prompt: async () => 'admin', notify: () => {} },
  })
  assert.equal(accountStatus.status, 'authorized')
  assert.equal(records.get(auth.accountRecordKey())?.payload?.account, 'admin')

  // ④ 反安慰剂：一条**忘记提交记录**的流程会被真实服务拒绝（证明上一条的通过不是空转）
  authorization.registerFlow({
    key: 'contract-probe/forgets-to-commit',
    label: '故意不提交',
    methods: [{ id: 'noop', label: 'noop' }],
    async run () {},
  })
  await assert.rejects(
    authorization.begin({ key: 'contract-probe/forgets-to-commit', interaction: { prompt: async () => '', notify: () => {} } }),
    (error) => error.code === 'NOT_COMMITTED',
  )

  dispose()
})

test('真实装载器：把本包当 profile bundle 装进一个 profile 后，能解析出它的补丁层并正确组合', { skip }, async () => {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const url = await import('node:url')

  const packageDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
  const simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-sim-profile-'))
  const scopeDir = path.join(simDir, 'node_modules', '@local')
  const linked = path.join(scopeDir, 'dsh-plugin-zentao')

  fs.mkdirSync(scopeDir, { recursive: true })
  fs.writeFileSync(path.join(simDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-sim',
    private: true,
    dsh: { profile: { bundles: ['@local/dsh-plugin-zentao'] } },
  }, null, 2))
  fs.writeFileSync(path.join(simDir, 'cordis.yml'), '[]\n')
  // 模拟 pnpm install 的产物：node_modules 里指向本包目录的 junction
  fs.symlinkSync(packageDir, linked, 'junction')

  try {
    const profile = boot.loadProfileDirectory('dsh', simDir, simDir)
    assert.deepEqual(profile.skippedBundles, [], '本包不该被跳过（应通过兼容性检查并读到 dsh.bundle）')

    const layers = profile.layers ?? []
    assert.equal(layers.length, 1, '应当只有本包这一层')
    assert.equal(layers[0].packageName, '@local/dsh-plugin-zentao')
    assert.deepEqual(layers[0].patchPaths.map((p) => fs.existsSync(p)), [true], '补丁文件必须真实存在')
    assert.equal(layers[0].patches.length, 1, '补丁应被解析成一条 insert 行')

    // 正确用法：每层贡献的是**补丁列表**
    const composed = boot.composeEntries(layers.map((layer) => layer.patches), () => {})
    const row = composed.find((entry) => entry.id === 'zentao')
    assert.ok(row, '组合结果里必须出现 zentao 行')
    assert.equal(row.name, '@local/dsh-plugin-zentao')
    assert.equal(row.config.accountRef, 'ZENTAO_ACCOUNT')
    assert.equal(row.config.passwordRef, 'ZENTAO_PASSWORD')
    assert.equal(row.config.writePolicy, 'confirm')
    assert.equal(row.config.dialect, 'auto')
  } finally {
    // **安全清理**：先只删 junction 本身（绝不递归进目标），确认删掉后才删临时目录。
    // 若 unlink 失败就宁可留下临时目录，也绝不冒险让递归删除碰到工作区。
    let junctionGone = false
    try {
      fs.unlinkSync(linked)
      junctionGone = !fs.existsSync(linked)
    } catch {
      junctionGone = !fs.existsSync(linked)
    }
    if (junctionGone) fs.rmSync(simDir, { recursive: true, force: true })
  }
})
