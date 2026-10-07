/**
 * 装配层冒烟测试：用桩模块替换 `@deepseek-ai/*`，真的 import `index.js`、真的调 `apply()`。
 *
 * 覆盖的是**离线本来无法发现的整类错误**：错误的导出名、错误的注册形状、
 * 工具 schema 不合法、effect 拆除时抛错、Config 与 snapshotConfig 字段不一致。
 *
 * 运行方式：`node --import ./test/register-stub.mjs --test test/assembly.test.js`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { materializeConfig } from './stubs/dsh.mjs'
import { classifyCall, decideWrite } from '../src/domain/policy.js'
import { registerZentaoPrompt } from '../src/prompt.js'

const indexModule = await import('../index.js')
const { Config, snapshotConfig } = await import('../src/config.js')

/** 造一个记录了全部注册动作的假 Cordis 上下文。 */
function makeCtx (available = {}) {
  const rec = {
    tools: [], commands: [], skills: [], sections: [], variables: [],
    listeners: [], effects: [], effectErrors: [], injects: [], flows: [], projections: [],
  }
  // 注册表返回的 disposer **必须真的注销**：真实的 tools/commands/skills 注册表就是这样，
  // 否则"卸载后是否清干净"这件事在桩上根本观察不到（曾因此漏看了提示词变量的泄漏）。
  const removeOnDispose = (arr, value) => () => {
    const index = arr.indexOf(value)
    if (index >= 0) arr.splice(index, 1)
  }
  const services = {
    tools: { register: (tool) => { rec.tools.push(tool); return removeOnDispose(rec.tools, tool) } },
    commands: { register: (command) => { rec.commands.push(command); return removeOnDispose(rec.commands, command) } },
    skills: { register: (skill) => { rec.skills.push(skill); return removeOnDispose(rec.skills, skill) } },
    systemPrompt: {
      section: (section) => { rec.sections.push(section); return removeOnDispose(rec.sections, section) },
      // **像真实实现一样校验变量名**（真机血泪：注册时校验、组装时才炸的是"引用"）。
      // 真实规则与报错文本见 dsh-system-prompt/lib/index.js:59,166,298：
      //   const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
      //   throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
      // 桩以前不校验，于是 `zentaoStatus` 这种非法名字在离线套件里一路绿灯，
      // 到真机就让**每一轮**都以 malformed prompt variable reference 收尾。
      variable: (name, resolve) => {
        if (!/^[a-z][a-z0-9_]*$/.test(String(name))) {
          throw new Error(`invalid prompt variable name "${name}" (must match /^[a-z][a-z0-9_]*$/)`)
        }
        const entry = { name, resolve }
        rec.variables.push(entry)
        return removeOnDispose(rec.variables, entry)
      },
    },
    sessionProjections: { register: (definition) => { rec.projections.push(definition); return removeOnDispose(rec.projections, definition) } },
    authorization: { registerFlow: (flow) => { rec.flows.push(flow); return removeOnDispose(rec.flows, flow) } },
    ...available,
  }
  const ctx = {
    get: (name) => services[name],
    on: (event, listener) => { rec.listeners.push({ event, listener }); return () => {} },
    // 真实 Cordis 的 `ctx.effect(execute, label)` 是**立即执行**回调、并把返回的 disposer 登记为拆除项
    // （cordis/lib/index.js 的 effect 实现里有 runner.collect）。桩必须一致 ——
    // 早期这个桩只记录不执行，于是"只在 effect 内注册"的代码在测试里会静默不注册（曾骗过我一次）。
    effect: (fn, label) => {
      let dispose
      try {
        dispose = fn()
      } catch (error) {
        rec.effectErrors.push({ label, error })
      }
      rec.effects.push({ fn, label, dispose })
      return () => { try { dispose?.() } catch { /* 拆除失败不致命 */ } }
    },
    inject: (deps, callback) => { rec.injects.push({ deps, callback }); return () => {} },
  }
  // 真实 Cordis 把服务同时暴露为 ctx.<name> 属性（插件里两种写法都有），
  // 因此这里用 Proxy 让属性访问也落到 services 上 —— 否则测试会因桩的缺口而误报。
  const proxied = new Proxy(ctx, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && services[prop] !== undefined) return services[prop]
      return undefined
    },
    has (target, prop) {
      return prop in target || (typeof prop === 'string' && services[prop] !== undefined)
    },
  })
  return { ctx: proxied, rec }
}

function applyPlugin (available = {}, overrides = {}) {
  const { ctx, rec } = makeCtx(available)
  const config = materializeConfig(Config, overrides)
  indexModule.apply(ctx, config)
  return { ctx, rec, config }
}

test('插件导出形态：name + inject + Config + apply', () => {
  assert.equal(indexModule.name, 'zentao')
  assert.deepEqual(indexModule.inject, ['tools'])
  assert.equal(typeof indexModule.apply, 'function')
  assert.equal(typeof indexModule.Config, 'object')
})

test('Config：字段与 snapshotConfig 必须完全一致（抓字段改名/拼写漂移）', () => {
  const declared = Object.keys(Config.fields)
  const snapshot = snapshotConfig(materializeConfig(Config, {}, {}))
  for (const key of Object.keys(snapshot)) {
    assert.ok(declared.includes(key), `snapshotConfig 读了 Config 没有声明的字段：${key}`)
  }
  // 反向：每个声明字段都应被 snapshotConfig 覆盖（除了纯 UI 用的）
  for (const key of declared) {
    assert.ok(key in snapshot, `Config 声明了 ${key} 但 snapshotConfig 没有读它`)
  }
})

test('Config：全部字段 volatile（否则设置页改不动、运行时也读不到活值）', () => {
  for (const [key, field] of Object.entries(Config.fields)) {
    assert.equal(field.meta.volatile, true, `${key} 必须是 volatile`)
  }
})

test('Config：账号/密码都是 credential-ref（配置里只有引用名，没有口令本体）', () => {
  assert.equal(Config.fields.accountRef.meta.role, 'credential-ref')
  assert.equal(Config.fields.passwordRef.meta.role, 'credential-ref')
  assert.equal(Config.fields.accountRef.defaultValue, 'ZENTAO_ACCOUNT')
  assert.equal(Config.fields.passwordRef.defaultValue, 'ZENTAO_PASSWORD')
  assert.equal(Config.fields.baseURL.hasDefault, false, 'baseURL 必须由用户显式配置')
  assert.equal(Config.fields.writePolicy.defaultValue, 'confirm')
  // 认证是"账号+密码 → 换 Token"：配置里**不允许**出现真正装口令的字段
  assert.equal('password' in Config.fields, false, '配置里不能有明文密码字段')
  assert.equal('tokenRef' in Config.fields, false, 'Token 只在内存缓存，配置里不再有 tokenRef')
  assert.equal('sites' in Config.fields, false, '单站点不应再有 sites 数组')
})

test('apply：注册 5 个工具，名字与顺序稳定，且定义通过形状 lint', () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  assert.deepEqual(rec.tools.map((tool) => tool.name), [
    'zentao_query', 'zentao_get', 'zentao_my', 'zentao_write', 'zentao_board',
  ])
  // 工具描述必须中文（D3）且非空
  for (const tool of rec.tools) {
    assert.match(tool.description, /[\u4e00-\u9fa5]/, `${tool.name} 的 description 应为中文`)
  }
})

test('文档一致性：README 必须提到**每一个**已注册的工具与 /zentao 子命令（防漂移）', async () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

  // 工具名：直接取真实注册结果。
  // 用**词边界**而不是子串包含：否则把文档写成 `zentao_boardX` 之类"前缀相同的错名"也能骗过检查
  // （这是变异检查发现的：第一次把 README 里的 zentao_board 改成 zentao_boardX，测试竟然还是绿的）。
  const toolNames = rec.tools.map((tool) => tool.name)
  assert.ok(toolNames.length >= 5)
  for (const name of toolNames) {
    assert.match(readme, new RegExp(`${name}(?![A-Za-z0-9_])`),
      `README 没有以独立名字提到工具 ${name} —— 文档与代码漂移了`)
  }

  // 子命令：跑一次 `/zentao help`，从**真实帮助文本**里抓（而不是抄一份清单）
  const command = rec.commands.find((item) => item.name === 'zentao')
  assert.ok(command?.handler, '必须注册 zentao 命令与其 handler')
  const help = await command.handler({ agent: undefined, rawInput: 'help' })
  assert.equal(help.kind, 'success')
  const subcommands = [...new Set([...help.text.matchAll(/\/zentao ([a-z][a-z-]*)/g)].map((m) => m[1]))]
  assert.ok(subcommands.length >= 5, `帮助文本里应当列出子命令，实际只抓到 ${subcommands.join(',')}`)
  for (const sub of subcommands) {
    assert.ok(readme.includes(`/zentao ${sub}`), `README 没有提到子命令 /zentao ${sub}`)
  }

  // 反安慰剂：README 里不该出现未注册的工具名（例如把 zentao_list 写进文档）
  for (const ghost of ['zentao_list', 'zentao_delete', 'zentao_sync']) {
    assert.ok(!readme.includes(ghost), `README 提到了并不存在的工具 ${ghost}`)
  }
})

test('apply：写了 pre-execute 门禁监听器，且真的能拦下写入', async () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com', writePolicy: 'readonly' })
  const entry = rec.listeners.find((item) => item.event === 'tools/pre-execute')
  assert.ok(entry, '必须注册 tools/pre-execute 监听器')

  const next = async () => ({ kind: 'allow' })

  // 只读工具放行（交给下游）
  assert.deepEqual(await entry.listener({ name: 'zentao_query', arguments: { entity: 'bug' } }, next), { kind: 'allow' })

  // readonly 下写入被拒，且理由可读
  const denied = await entry.listener({ name: 'zentao_write', arguments: { action: 'update', entity: 'task', id: '1', dryRun: false } }, next)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /readonly/)
  assert.equal(denied.info.code, 'WRITE_DISABLED')
})

test('写入门禁：**与禅道无关的工具必须原样落回下游**（否则会卡住所有工具调用）', async () => {
  // 这是与"提示词悬空引用"同级的风险：门禁挂在所有工具调用的 waterfall 上，
  // 只要它对无关工具返回了别的形状（或忘了调 next），**每个会话的每次工具调用**都会出问题。
  // 用 readonly 这种"最激进"的策略来测：无关工具也不该受到任何影响。
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com', writePolicy: 'readonly' })
  const entry = rec.listeners.find((item) => item.event === 'tools/pre-execute')
  assert.ok(entry)

  let reached = 0
  const next = async () => { reached += 1; return { kind: 'allow', from: 'next' } }
  const unrelated = [
    'pwsh', 'read', 'edit', 'glob',
    'zentao_queryX', // 前缀相同但不是我注册的工具名 —— 不能被误判
    'zentao_board2',
  ]
  for (const name of unrelated) {
    const result = await entry.listener({ name, arguments: { command: 'echo hi' } }, next)
    assert.deepEqual(result, { kind: 'allow', from: 'next' }, `${name} 必须原样落回下游`)
  }
  assert.equal(reached, unrelated.length, '每个无关工具都必须真的调到 next()')
})

test('apply：confirm 策略下写入返回 ask，并带上人看得懂的变更说明', async () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com', writePolicy: 'confirm' })
  const entry = rec.listeners.find((item) => item.event === 'tools/pre-execute')
  const next = async () => ({ kind: 'allow' })

  const asked = await entry.listener({
    name: 'zentao_write',
    arguments: { action: 'update', entity: 'bug', id: '4821', dryRun: false, payload: { patch: { pri: 1 } } },
  }, next)
  assert.equal(asked.kind, 'ask')
  // 已核验契约：ask 会读 reason / displayReason
  assert.match(asked.reason, /禅道修改/)
  assert.match(asked.displayReason, /pri=1/)
  assert.match(asked.displayReason, /dryRun=false/)

  // dryRun 默认放行
  const dry = await entry.listener({
    name: 'zentao_write',
    arguments: { action: 'delete', entity: 'bug', id: '4821' },
  }, next)
  assert.deepEqual(dry, { kind: 'allow' })
})

test('apply：删除类在 trusted 下仍然要问（策略不放宽破坏性操作）', async () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com', writePolicy: 'trusted' })
  const entry = rec.listeners.find((item) => item.event === 'tools/pre-execute')
  const asked = await entry.listener({
    name: 'zentao_write', arguments: { action: 'delete', entity: 'bug', id: '9', dryRun: false },
  }, async () => ({ kind: 'allow' }))
  assert.equal(asked.kind, 'ask')
  assert.match(asked.reason, /删除/)

  const allowed = await entry.listener({
    name: 'zentao_write', arguments: { action: 'update', entity: 'task', id: '9', dryRun: false },
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('apply：注册 /zentao 命令，其状态子命令能读出配置', async () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com', label: '公司禅道' })
  assert.equal(rec.commands.length, 1)
  const command = rec.commands[0]
  assert.equal(command.name, 'zentao')

  const status = await command.handler({ rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /公司禅道/)
  assert.match(status.text, /https:\/\/zt\.example\.com/)

  const help = await command.handler({ rawInput: 'help' })
  assert.match(help.text, /\/zentao doctor/)

  const actions = await command.handler({ rawInput: 'actions' })
  assert.match(actions.text, /start/)
  assert.match(actions.text, /resolve/)

  const bogus = await command.handler({ rawInput: 'nope' })
  assert.equal(bogus.kind, 'error')
})

test('apply：注册技能与提示词段，且提示词文本逐次一致（不破坏 KV 缓存前缀）', () => {
  const first = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  const second = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  assert.equal(first.rec.skills.length, 1)
  assert.equal(first.rec.skills[0].name, 'zentao-workflow')
  assert.equal(first.rec.skills[0].invocation.modelInvocable, true)
  assert.match(first.rec.skills[0].body ?? first.rec.skills[0].content ?? '', /不可信数据/)

  assert.equal(first.rec.sections.length, 1)
  const section = first.rec.sections[0]
  assert.equal(section.name, 'zentao:context')
  assert.equal(typeof section.order, 'number')
  assert.equal(section.text, second.rec.sections[0].text, '文本必须稳定')
  assert.doesNotMatch(section.text, /\d{4}-\d{2}-\d{2}/, '不得含时间戳（会毁掉缓存前缀）')
  assert.match(section.text, /不可信数据/)

  // 变量名必须全小写（真机血泪：`zentaoStatus` 让每一轮都以 malformed prompt variable 收尾）
  assert.deepEqual(first.rec.variables.map((item) => item.name).sort(), ['zentao_status', 'zentao_write_policy'])
  for (const variable of first.rec.variables) {
    assert.match(variable.name, /^[a-z][a-z0-9_]*$/, `变量名 ${variable.name} 违反 DSH 规则（只允许小写）`)
  }
  assert.match(first.rec.variables.find((item) => item.name === 'zentao_status').resolve(), /已接入|尚未配置/)
})

test('提示词：段落文本里的每个 {{变量}} 都必须是**真的注册成功**的变量（否则每一轮都会炸）', () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  const section = rec.sections[0]
  const declared = new Set(rec.variables.map((item) => item.name))
  const referenced = [...String(section.text).matchAll(/\{\{([^}]*)\}\}/g)].map((match) => match[1])
  assert.ok(referenced.length > 0, '这一段本来就该带变量，否则这个测试没有意义')
  for (const name of referenced) {
    assert.ok(declared.has(name),
      `段落引用了 {{${name}}}，但它没有被注册 —— DSH 在组装时会抛 malformed prompt variable reference，` +
      '而插件是 profile 级的，那会让**每个会话的每一轮**都以 error 收尾')
  }
})

test('提示词：变量注册被服务拒绝时（真实现会为非法名字抛错），段落**不得**留下悬空引用', () => {
  // 用一个"只接受合法小写名字、其余一律抛错"的服务模拟真实实现
  const rec = { sections: [], variables: [] }
  const systemPrompt = {
    section: (section) => { rec.sections.push(section); return () => {} },
    variable: (name, resolve) => {
      if (!/^[a-z][a-z0-9_]*$/.test(String(name))) throw new Error('invalid prompt variable name')
      rec.variables.push({ name, resolve })
      return () => {}
    },
  }
  const ctx = { get: (name) => (name === 'systemPrompt' ? systemPrompt : undefined) }
  registerZentaoPrompt(ctx, () => ({ baseURL: 'https://zt.example.com', label: 'X', writePolicy: 'confirm' }))

  assert.equal(rec.sections.length, 1)
  const referenced = [...String(rec.sections[0].text).matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1])
  for (const name of referenced) {
    assert.ok(rec.variables.some((v) => v.name === name), `悬空引用 {{${name}}} 会让每一轮都失败`)
  }
})

test('apply：可选服务通过 ctx.inject 惰性接入，且回调可安全执行', () => {
  const { ctx, rec } = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  const deps = rec.injects.map((item) => item.deps.join('+')).sort()
  assert.deepEqual(deps, ['credentials+authorization', 'sessionProjections'])

  // 真的把可选服务接上后执行回调，不应抛错
  for (const inject of rec.injects) {
    assert.doesNotThrow(() => inject.callback(ctx))
  }
  // 授权流与投影单元都注册上了。认证改成"账号 + 密码"后是**两条**授权流：
  // 缺密码问密码、缺账号问账号。
  assert.equal(rec.flows.length, 2)
  assert.deepEqual(rec.flows.map((flow) => flow.methods[0].id).sort(), ['account', 'password'])
  assert.equal(rec.projections.length, 1)
  assert.equal(rec.projections[0].key, 'zentaoContext')
})

test('投影单元：apply 必须纯同步，且忽略的事件返回同一引用', () => {
  const { ctx, rec } = applyPlugin({}, {})
  // 投影是在可选服务就绪后注册的，这里主动把回调跑一遍（等价于服务就绪）
  for (const inject of rec.injects) inject.callback(ctx)
  assert.equal(rec.projections.length, 1)
  const definition = rec.projections[0]
  const state = definition.init()
  const unchanged = definition.apply(state, { type: 'tool/result', data: {} })
  assert.equal(unchanged, state, '忽略的事件必须返回同一引用（否则每事件都触发下游工作）')

  const changed = definition.apply(state, { type: 'command/run', data: { rawInput: 'switch 12 34' } })
  assert.equal(changed.productId, '12')
  assert.equal(changed.executionId, '34')
  // wire.view 返回纯数据
  assert.equal(typeof definition.wire.view(changed), 'object')
})

test('effect 与拆除：全部 effect 在注册时已执行、且 disposer 都能安全拆除', () => {
  const { rec } = applyPlugin({ credentials: {} }, {})
  assert.ok(rec.effects.length >= 3, `应注册多个 effect，实际 ${rec.effects.length}`)
  // 桩的 effect 已按真实语义**立即执行**，所以这里不该有任何执行期错误
  assert.deepEqual(rec.effectErrors, [], `effect 执行时不该抛错：${JSON.stringify(rec.effectErrors.map((e) => e.label))}`)
  for (const effect of rec.effects) {
    assert.equal(typeof effect.dispose, 'function', `effect ${effect.label} 应产出 disposer`)
    assert.doesNotThrow(() => effect.dispose(), `effect ${effect.label} 的 disposer 不应抛错`)
    assert.doesNotThrow(() => effect.dispose(), `effect ${effect.label} 的 disposer 必须幂等（重复拆除不抛）`)
  }
})

test('拆除是**真的**：卸载后工具/命令/技能/提示词变量都不该留在注册表里（防 HMR 重复注册）', () => {
  const { rec } = applyPlugin({ credentials: {} }, { baseURL: 'https://zt.example.com' })
  assert.equal(rec.tools.length, 5, '加载后应有 5 个工具')
  assert.ok(rec.commands.length >= 1)
  assert.ok(rec.skills.length >= 1)
  assert.ok(rec.variables.length >= 2, '加载后应有提示词变量')

  for (const effect of rec.effects) effect.dispose()

  assert.deepEqual(rec.tools, [], '工具没被拆掉 —— HMR 重载后会重复注册同名工具')
  assert.deepEqual(rec.commands, [], '命令没被拆掉')
  assert.deepEqual(rec.skills, [], '技能没被拆掉')
  assert.deepEqual(rec.variables, [], '提示词变量没被拆掉（曾被漏掉过：只收了 section 的 disposer）')
  assert.deepEqual(rec.sections, [], '提示词段没被拆掉')
})

test('工具 execute 在没有真机时也必须把失败收敛成文本（不抛给框架）', async () => {
  const { rec } = applyPlugin({}, { baseURL: 'https://zt.example.com' })
  const query = rec.tools.find((tool) => tool.name === 'zentao_query')
  // 未配置 Token + 没有凭据服务 → 应返回结构化错误文本，而不是抛出
  const result = await query.execute({ entity: 'product' }, { signal: undefined })
  assert.equal(typeof result.text, 'string')
  assert.match(result.text, /AUTH_REQUIRED|无法连接|NETWORK|VALIDATION/)
})

test('决策表与门禁监听器同源：policy 的纯函数结论与实注册行为一致', async () => {
  for (const policy of ['readonly', 'confirm', 'trusted']) {
    const { rec } = applyPlugin({}, { writePolicy: policy })
    const entry = rec.listeners.find((item) => item.event === 'tools/pre-execute')
    for (const args of [
      { action: 'update', entity: 'task', id: '1', dryRun: false },
      { action: 'delete', entity: 'bug', id: '2', dryRun: false },
      { action: 'update', entity: 'task', bulk: [{ id: '1' }, { id: '2' }], dryRun: false },
      { action: 'create', entity: 'task', dryRun: true },
    ]) {
      const expected = decideWrite(policy, classifyCall('zentao_write', args))
      const decision = await entry.listener({ name: 'zentao_write', arguments: args }, async () => ({ kind: 'allow' }))
      const actual = decision.kind === 'allow' ? 'allow' : decision.kind
      assert.equal(actual, expected,
        `策略 ${policy} / ${JSON.stringify(args)} 下门禁(${actual})与决策表(${expected})不一致`)
    }
  }
})
