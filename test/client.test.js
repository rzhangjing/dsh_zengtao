/**
 * Client 半的离线测试。
 *
 * 为什么值得写：client.js 是手写的 `__ModuleLoader__` factory（不能用 JSX、不能 import
 * Harness Client 包），因此它曾经**零覆盖**，而这类代码的典型故障是"整个槽位空白"
 * 与"谎报保存成功"。
 *
 * 夹具有状态 hook 与重渲染能力 —— 这一点是必要的：如果只断言"渲染出来了"，
 * 就抓不到"Host 拒绝写入时仍显示已保存"这类**交互路径**上的错误（真实发生过）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/* ── 先装 window.__ModuleLoader__，再动态 import（ESM 静态 import 会被提升）── */
let definition
globalThis.window = {
  __ModuleLoader__: {
    load (def) { definition = def },
  },
}
await import('../client.js')

/**
 * 极简但并不简陋的 React 桩：真的维护 hook 状态、真的渲染函数组件、支持重渲染。
 * 只在首次挂载时跑 useEffect（避免副作用反复触发）。
 */
function makeReact () {
  const calls = { effects: 0 }
  const hooks = []
  let cursor = 0
  let mounted = false
  const React = {
    calls,
    createElement (type, props, ...children) {
      const merged = { ...(props ?? {}), children: children.length <= 1 ? children[0] : children }
      // 函数组件立刻求值：断言看到的是真正渲染出来的树，而不是包装元素
      return typeof type === 'function' ? type(merged) : { type, props: merged }
    },
    useState (initial) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
    },
    useMemo (fn) { cursor += 1; return fn() },
    useCallback (fn) { cursor += 1; return fn },
    useEffect (fn) {
      cursor += 1
      if (mounted) return undefined
      calls.effects += 1
      try { return fn() } catch { return undefined }
    },
    /** 渲染（或重渲染）一个组件：每次都重置 hook 游标，状态在 hooks 里存活。 */
    render (Component, props) {
      cursor = 0
      const tree = Component(props)
      mounted = true
      return tree
    },
  }
  return React
}

/** `t` 桩：把 key 原样带前缀返回，便于断言"显示了哪条文案"。 */
const makeT = () => (key) => `t:${key}`

function makeRequire (React) {
  return (name) => {
    if (name !== 'react') throw new Error(`client.js 只允许 require('react')，收到：${name}`)
    return React
  }
}

function makeClient (options = {}) {
  const rec = { locales: [], slots: [], effects: [] }
  const services = {
    locale: {
      register: (ns, dict) => { rec.locales.push({ ns, dict }); return () => {} },
      bind: () => makeT(),
    },
    configForms: {
      whileServed: (namespaces, register) => { rec.whileServed = namespaces; register(); return () => {} },
      get: () => options.scope,
    },
    slots: {
      inject: (slotId, register) => { rec.slots.push({ slotId, def: register() }); return () => {} },
      register: (meta, component) => ({ meta, component }),
    },
    remote: {
      credentials: {
        describe: options.describe ?? (async () => ({ ok: true, value: {} })),
        set: options.credentialsSet ?? (async () => ({ ok: true, value: true })),
      },
      commands: { execute: options.execute ?? (async () => ({ ok: true, value: { result: { text: '看板文本' } } })) },
    },
    sessions: options.sessions ?? { binding: () => undefined },
  }
  const ctx = new Proxy({
    // 真实 Cordis 的 effect 会**立即执行** fn，并把返回值当作 disposer。
    effect: (fn, label) => {
      const dispose = fn()
      rec.effects.push({ fn, label, dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && services[prop] !== undefined) return services[prop]
      return undefined
    },
  })
  return { ctx, rec }
}

function applyClient (options = {}) {
  const React = makeReact()
  const module = definition.factory(makeRequire(React))
  const { ctx, rec } = makeClient(options)
  module.apply(ctx)
  return { module, React, ctx, rec }
}

/** 把渲染出来的元素树摊平成文本。 */
function flatten (node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out }
  flatten(node.props?.children, out)
  return out
}

/** 摊平成元素列表（用来找按钮并驱动交互）。 */
function collect (node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  collect(node.props?.children, out)
  return out
}

/** 找到文案为 `t:save` 的按钮（field()/booleanField() 渲染出来的那个）。 */
function saveButtons (tree) {
  return collect(tree).filter((element) => element.type === 'button' && element.props?.children === 't:save')
}

/** 凭据区那一个"保存账号与密码"按钮（区别于每个配置字段各自的"保存"）。 */
function credentialSaveButton (tree) {
  return collect(tree).find((element) => element.type === 'button' && element.props?.children === 't:saveCredentials')
}

const cardOf = (rec) => rec.slots.find((slot) => slot.slotId === 'plugins.item').def.component
const dockOf = (rec) => rec.slots.find((slot) => slot.slotId === 'conversation.input.dock').def.component

/* ─────────────── 注册形状 ─────────────── */

test('client.js：工厂 id 必须等于包名（否则模块表注册不上）', () => {
  assert.equal(definition.id, '@local/dsh-plugin-zentao')
  assert.equal(typeof definition.factory, 'function')
})

test('client.js：只 require("react")，不 import 任何 Harness Client 包', () => {
  const React = makeReact()
  const strict = (name) => { throw new Error(`不允许 require(${name})`) }
  const module = definition.factory((name) => (name === 'react' ? React : strict(name)))
  assert.equal(typeof module.apply, 'function')
})

test('client.js：注入的服务名都在已核验范围内，且 `remote.*` 必须同时声明顶层 `remote`', () => {
  const React = makeReact()
  const module = definition.factory(makeRequire(React))
  const known = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials', 'remote.commands', 'sessions']
  for (const name of module.inject) {
    assert.ok(known.includes(name), `意外的注入服务名：${name}`)
  }
  // **真机踩过**：只注入 `remote.credentials` / `remote.commands` 时，访问 `ctx.remote` 会抛
  // `cannot get property "remote" without inject`。真实客户端插件的写法是
  // `["remote", "remote.settings"]`（dsh-client-ui-settings/lib/client.js:1503）——
  // 即**顶层服务名 + 具体子路径都要列出**。这里把这条规则钉住。
  const dotted = module.inject.filter((name) => name.includes('.'))
  for (const name of dotted) {
    const root = name.split('.')[0]
    assert.ok(module.inject.includes(root),
      `注入了 ${name} 却没有顶层 ${root} —— 真机上访问 ctx.${root} 会被拒`)
  }
  // 我的 client.js 确实用了 ctx.remote.*，所以 remote 必须在列
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  if (/ctx\.remote\./.test(source)) {
    assert.ok(module.inject.includes('remote'), '代码里用了 ctx.remote.* 就必须注入 remote')
  }
})

test('client.js：**不得硬编码颜色** —— 颜色字面量只能作为 var(--token, fallback) 的兜底', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g
  const found = [...source.matchAll(COLOR)].map((m) => m[0])
  assert.ok(found.length > 0, '应当至少用到若干主题令牌（带 fallback）')

  for (const match of source.matchAll(COLOR)) {
    const before = source.slice(0, match.index)
    const lastVar = before.lastIndexOf('var(--')
    assert.notEqual(lastVar, -1, `颜色字面量 ${match[0]} 不在主题令牌里 —— 暗色主题下会串色`)
    // 令牌与字面量之间必须恰好是 "var(--xxx, " —— 即字面量是 fallback 的第一个值
    assert.match(
      before.slice(lastVar),
      /^var\(\s*--[a-zA-Z0-9-]+\s*,\s*$/,
      `颜色字面量 ${match[0]} 必须是 var(--token, <fallback>) 里的 fallback`,
    )
  }
})

test('apply：注册中英双语文案（两种语言必须齐全，否则注册会失败）', () => {
  const { rec } = applyClient()
  assert.equal(rec.locales.length, 1)
  const { ns, dict } = rec.locales[0]
  assert.equal(ns, 'zentao')
  assert.deepEqual(Object.keys(dict).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
  assert.match(dict.zh.title, /禅道/)
  assert.match(dict.en.title, /ZenTao/)
})

test('apply：挂在 plugins.item 上并在 whileServed(["zentao"]) 内注册', () => {
  const { rec } = applyClient()
  assert.deepEqual(rec.whileServed, ['zentao'])
  const card = rec.slots.find((slot) => slot.slotId === 'plugins.item')
  assert.equal(card.def.meta.name, 'plugins.item')
  assert.equal(card.def.meta.id, 'zentao')
  assert.equal(card.def.meta.locale, 'zentao')
})

test('apply：会话卡片注册到 composer 上下文栈，并用 inject(sessionId) 取会话 id', () => {
  const { rec } = applyClient()
  const dock = rec.slots.find((slot) => slot.slotId === 'conversation.input.dock')
  assert.equal(typeof dock.def.meta.inject, 'function')
  assert.deepEqual(dock.def.meta.inject('session-1'), { sessionId: 'session-1' })
})

test('effect 都能安全注册与拆除', () => {
  const { rec } = applyClient()
  assert.equal(rec.effects.length, 5, '应注册 locale + 设置卡片 + 会话卡片 + 看板页面 + 侧栏入口五个 effect')
  for (const effect of rec.effects) {
    assert.equal(typeof effect.dispose, 'function', `effect ${effect.label} 应返回 disposer`)
    assert.doesNotThrow(() => effect.dispose(), `effect ${effect.label} 的 disposer 不应抛错`)
  }
})

/* ─────────────── 全屏看板与侧栏入口（形状取自真实实现） ─────────────── */

/** 假 sessions 服务：形状对齐真实实现 dsh-client-ui-session/lib/client.js:281-285,340,344 */
function makeSessions ({ mainView, otherViews = [], throwOn = undefined } = {}) {
  const byId = {}
  if (mainView) byId[mainView] = { id: mainView }
  for (const id of otherViews) byId[id] = { id }
  return {
    list: { getSnapshot: () => ({ phase: 'ready', byId }) },
    binding: () => undefined,
    retainInfo: (id) => {
      if (throwOn === id) throw new Error('shape changed')
      return { getSnapshot: () => ({ retainedBy: { mainView: id === mainView ? 1 : 0 } }) }
    },
  }
}

test('注册形状：`main` 用 key，`sidebar.panellist` 用**同一个 id**（这是两者的关联方式）', () => {
  const { rec } = applyClient()
  const main = rec.slots.find((slot) => slot.slotId === 'main')
  const panel = rec.slots.find((slot) => slot.slotId === 'sidebar.panellist')
  assert.ok(main, '必须注册 main 槽位')
  assert.ok(panel, '必须注册 sidebar.panellist 入口')
  assert.equal(main.def.meta.name, 'main')
  assert.equal(main.def.meta.key, 'zentao-board', 'main 用 key')
  assert.equal(panel.def.meta.name, 'sidebar.panellist')
  assert.equal(panel.def.meta.id, 'zentao-board', '侧栏入口的 id 必须等于 main 的 key')
  assert.equal(typeof panel.def.meta.order, 'number')
  assert.equal(panel.def.meta.label(), 't:panelTitle')
  assert.equal(typeof main.def.component, 'function')
  assert.equal(typeof panel.def.component, 'function')
})

test('侧栏入口图标能渲染，且绝不抛错', () => {
  const { rec, React, ctx } = applyClient({ sessions: makeSessions({ mainView: 's1' }) })
  const panel = rec.slots.find((slot) => slot.slotId === 'sidebar.panellist')
  const tree = React.render(panel.def.component, { t: makeT(), ctx })
  assert.match(flatten(tree).join(''), /禅/)
})

test('看板页面：从真实形状的 sessions 服务里找出**主视图会话**并展示上下文', () => {
  const sessions = makeSessions({ mainView: 's2', otherViews: ['s1', 's3'] })
  const { rec, React, ctx } = applyClient({
    sessions: {
      ...sessions,
      binding: (id) => (id === 's2'
        ? { session: { projections: { faceOf: (kind) => (kind === 'zentaoContext' ? { getSnapshot: () => ({ productId: '12', productTitle: '产品A', executionId: '34' }) } : undefined) } } }
        : undefined),
    },
  })
  const main = rec.slots.find((slot) => slot.slotId === 'main')
  const tree = React.render(main.def.component, { t: makeT(), ctx })
  const text = flatten(tree).join(' ')
  assert.match(text, /t:panelTitle/)
  assert.match(text, /产品A/)
  assert.match(text, /34/)
})

test('看板页面：点刷新会用**主视图会话**执行 /zentao board，并渲染返回文本', async () => {
  const calls = []
  const sessions = makeSessions({ mainView: 's2', otherViews: ['s1'] })
  const { rec, React, ctx } = applyClient({
    sessions: {
      ...sessions,
      binding: (id) => (id === 's2'
        ? { session: { projections: { faceOf: (kind) => (kind === 'zentaoContext' ? { getSnapshot: () => ({ executionId: '34' }) } : undefined) } } }
        : undefined),
    },
    execute: async (sessionId, line) => { calls.push([sessionId, line]); return { ok: true, value: { result: { text: '禅道看板 · execution #34' } } } },
  })
  const main = rec.slots.find((slot) => slot.slotId === 'main')
  const props = { t: makeT(), ctx }
  let tree = React.render(main.def.component, props)
  const refresh = collect(tree).find((el) => el.type === 'button' && el.props?.children === 't:refresh')
  assert.ok(refresh, '应有刷新按钮')
  await refresh.props.onClick()
  tree = React.render(main.def.component, props)
  assert.deepEqual(calls, [['s2', '/zentao board 34']], '必须用主视图会话执行命令')
  assert.match(flatten(tree).join(' '), /禅道看板 · execution #34/)
})

test('看板页面：没有会话时明确说明，而不是静默无反应', async () => {
  const { rec, React, ctx } = applyClient({ sessions: makeSessions({}) })
  const main = rec.slots.find((slot) => slot.slotId === 'main')
  const props = { t: makeT(), ctx }
  let tree = React.render(main.def.component, props)
  const refresh = collect(tree).find((el) => el.type === 'button' && el.props?.children === 't:refresh')
  await refresh.props.onClick()
  tree = React.render(main.def.component, props)
  assert.match(flatten(tree).join(' '), /t:noSession/)
})

test('看板页面：sessions 形状异常（retainInfo 抛错）时降级为空态，不崩', () => {
  const sessions = makeSessions({ mainView: 's2', otherViews: ['s1'], throwOn: 's1' })
  const { rec, React, ctx } = applyClient({ sessions })
  const main = rec.slots.find((slot) => slot.slotId === 'main')
  assert.doesNotThrow(() => React.render(main.def.component, { t: makeT(), ctx }))
})

test('看板页面：收起后只留"展开"按钮，可再打开（对应"侧栏入口可打开/关闭面板"）', async () => {
  const { rec, React, ctx } = applyClient({ sessions: makeSessions({ mainView: 's1' }) })
  const main = rec.slots.find((slot) => slot.slotId === 'main')
  const props = { t: makeT(), ctx }
  let tree = React.render(main.def.component, props)
  const collapse = collect(tree).find((el) => el.type === 'button' && el.props?.children === 't:collapse')
  assert.ok(collapse, '应有收起按钮')
  await collapse.props.onClick()
  tree = React.render(main.def.component, props)
  const text = flatten(tree).join(' ')
  assert.match(text, /t:expand/)
  assert.doesNotMatch(text, /t:panelTitle/, '收起后不该再显示面板内容')
})

/* ─────────────── 设置卡片：读 ─────────────── */

test('设置卡片：首帧就显示当前配置（不闪空卡片）并带 CAS 版本号', () => {
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'https://zt.example.com', writePolicy: 'confirm', dialect: 'auto', tokenRef: 'ZENTAO_TOKEN' }, revision: 7, writable: true, mode: 'host' }),
    set: async () => true,
  }
  const { rec, React, ctx } = applyClient({ scope })
  const tree = React.render(cardOf(rec), { t: makeT(), ctx })
  const text = flatten(tree).join(' ')
  assert.match(text, /https:\/\/zt\.example\.com/)
  assert.match(text, /readonly|confirm|trusted/)
  assert.match(text, /revision 7/)
})

test('设置卡片：作用域快照读不到时给出明确说明（不空白、不许假）', () => {
  const { rec, React, ctx } = applyClient({ scope: undefined })
  const tree = React.render(cardOf(rec), { t: makeT(), ctx })
  assert.match(flatten(tree).join(' '), /t:unreadable/)
})

test('设置卡片：mode 在**快照**上，memory 模式时要提示写入可能不会保存', () => {
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'https://zt.example.com' }, mode: 'memory', status: 'unavailable', writable: false }),
    set: async () => false,
  }
  const { rec, React, ctx } = applyClient({ scope })
  const tree = React.render(cardOf(rec), { t: makeT(), ctx })
  const text = flatten(tree).join(' ')
  assert.match(text, /t:memoryMode/, '内存模式必须提示（真实实现里此时所有写入都是空操作）')
})

test('设置卡片：Host 明确不可写时，保存按钮必须是禁用的', () => {
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'x', label: 'y' }, writable: false, mode: 'host' }),
    set: async () => false,
  }
  const { rec, React, ctx } = applyClient({ scope })
  const tree = React.render(cardOf(rec), { t: makeT(), ctx })
  const buttons = saveButtons(tree)
  assert.ok(buttons.length > 0, '应渲染出保存按钮')
  for (const button of buttons) {
    assert.equal(button.props.disabled, true, 'writable === false 时保存按钮不该是可点的')
  }
})

/* ─────────────── 设置卡片：写（交互路径） ─────────────── */

test('设置卡片：Host 接受写入时才显示"已保存"', async () => {
  const setCalls = []
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'https://zt.example.com', label: '禅道' }, revision: 3, writable: true, mode: 'host' }),
    set: async (field, value) => { setCalls.push([field, value]); return true },
  }
  const { rec, React, ctx } = applyClient({ scope })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)
  const button = saveButtons(tree)[0]
  assert.ok(button, '应找到保存按钮')
  await button.props.onClick()
  tree = React.render(cardOf(rec), props)
  const text = flatten(tree).join(' ')
  assert.equal(setCalls.length, 1, '应真的调用 scope.set')
  assert.equal(setCalls[0][0], 'label', '第一个字段是站点名')
  assert.match(text, /t:saved/)
  assert.doesNotMatch(text, /t:conflict/)
})

test('设置卡片：Host **拒绝**写入（set 返回布尔 false）时绝不能显示"已保存"', async () => {
  const setCalls = []
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'https://zt.example.com', label: '禅道' }, revision: 3, writable: true, mode: 'host' }),
    // 已核验契约：失败时 set 返回 false（内部已自行做过恢复读取）
    set: async (field, value) => { setCalls.push([field, value]); return false },
  }
  const { rec, React, ctx } = applyClient({ scope })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)
  await saveButtons(tree)[0].props.onClick()
  tree = React.render(cardOf(rec), props)
  const text = flatten(tree).join(' ')
  assert.equal(setCalls.length, 1)
  assert.match(text, /t:conflict/, '被拒绝时必须提示冲突/未保存')
  assert.doesNotMatch(text, /t:saved/, '绝不能谎报保存成功')
})

test('设置卡片：内存模式下被拒绝时，提示说的是"不会保存"而不是"冲突"', async () => {
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'x', label: 'y' }, mode: 'memory', status: 'unavailable' }),
    set: async () => false,
  }
  const { rec, React, ctx } = applyClient({ scope })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)
  await saveButtons(tree)[0].props.onClick()
  tree = React.render(cardOf(rec), props)
  const text = flatten(tree).join(' ')
  assert.match(text, /t:memoryMode/)
  assert.doesNotMatch(text, /t:saved/)
})

test('设置卡片：scope.set 抛错时把错误显示出来，而不是崩掉槽位', async () => {
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'x', label: 'y' }, writable: true, mode: 'host' }),
    set: async () => { throw new Error('boom') },
  }
  const { rec, React, ctx } = applyClient({ scope })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)
  await assert.doesNotReject(async () => { await saveButtons(tree)[0].props.onClick() })
  tree = React.render(cardOf(rec), props)
  assert.match(flatten(tree).join(' '), /boom/)
})

test('设置卡片：client 没有 scope.set 时明确说明，而不是静默无反应', async () => {
  const scope = { getSnapshot: () => ({ value: { baseURL: 'x', label: 'y' }, writable: true, mode: 'host' }) }
  const { rec, React, ctx } = applyClient({ scope })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)
  await saveButtons(tree)[0].props.onClick()
  tree = React.render(cardOf(rec), props)
  assert.match(flatten(tree).join(' '), /没有暴露配置写入接口/)
})

test('设置卡片：账号与密码都走 remote.credentials.set（密码框留空则不写）', async () => {
  const setCalls = []
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'x', accountRef: 'ZENTAO_ACCOUNT', passwordRef: 'ZENTAO_PASSWORD' }, writable: true, mode: 'host' }),
    set: async () => true,
  }
  const { rec, React, ctx } = applyClient({
    scope,
    credentialsSet: async (ref, value) => { setCalls.push([ref, value]); return { ok: true, value: true } },
    describe: async () => ({
      ok: true,
      value: {
        ZENTAO_ACCOUNT: { configured: true, writable: true },
        ZENTAO_PASSWORD: { configured: false, writable: true },
      },
    }),
  })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)

  const password = collect(tree).find((element) => element.type === 'input' && element.props?.type === 'password')
  const textInputs = collect(tree).filter((element) => element.type === 'input' && element.props?.type !== 'password')
  assert.ok(password, '应渲染密码输入框')
  assert.ok(textInputs.length >= 2, '应至少渲染账号与引用名两个文本输入框')

  // 只填密码 → 只写密码
  password.props.onChange({ target: { value: 'pw-1' } })
  tree = React.render(cardOf(rec), props)
  await credentialSaveButton(tree).props.onClick()
  assert.deepEqual(setCalls, [['ZENTAO_PASSWORD', 'pw-1']], '只填密码时不该写账号')

  // 再填账号 → 写账号（按 placeholder 精确定位账号框，否则会拿到"站点名"等别的文本框）
  tree = React.render(cardOf(rec), props)
  const accountInput = collect(tree).find((element) =>
    element.type === 'input' && element.props?.placeholder === 't:accountPlaceholder')
  assert.ok(accountInput, '应渲染账号输入框')
  accountInput.props.onChange({ target: { value: 'admin' } })
  tree = React.render(cardOf(rec), props)
  await credentialSaveButton(tree).props.onClick()
  assert.deepEqual(setCalls, [['ZENTAO_PASSWORD', 'pw-1'], ['ZENTAO_ACCOUNT', 'admin']])
  // 保存后输入框被清空（不回显秘密）
  tree = React.render(cardOf(rec), props)
  const passwordAfter = collect(tree).find((element) => element.type === 'input' && element.props?.type === 'password')
  assert.equal(passwordAfter.props.value, '', '保存后不应回显密码')
})

test('设置卡片：凭据 RemoteResult 失败时显示错误（组件抛错会白掉整个槽位）', async () => {
  const scope = {
    getSnapshot: () => ({ value: { baseURL: 'x', accountRef: 'ZENTAO_ACCOUNT', passwordRef: 'ZENTAO_PASSWORD' }, writable: true, mode: 'host' }),
    set: async () => true,
  }
  const { rec, React, ctx } = applyClient({
    scope,
    credentialsSet: async () => ({ ok: false, error: { message: '版本冲突', code: 'settings/conflict' } }),
  })
  const props = { t: makeT(), ctx }
  let tree = React.render(cardOf(rec), props)
  const password = collect(tree).find((element) => element.type === 'input' && element.props?.type === 'password')
  password.props.onChange({ target: { value: 'tok-1' } })
  tree = React.render(cardOf(rec), props)
  await credentialSaveButton(tree).props.onClick()
  tree = React.render(cardOf(rec), props)
  assert.match(flatten(tree).join(' '), /版本冲突/)
})

/* ─────────────── 会话卡片 ─────────────── */

test('会话卡片：没有禅道上下文时**什么都不渲染**（不长期占据 composer 空间）', () => {
  const { rec, React, ctx } = applyClient({ sessions: { binding: () => undefined } })
  const tree = React.render(dockOf(rec), { t: makeT(), ctx, sessionId: 's1' })
  assert.equal(tree, null)
})

test('会话卡片：有上下文时显示产品/执行，并可从投影读到', () => {
  const sessions = {
    binding: () => ({
      session: {
        projections: {
          faceOf: (kind) => (kind === 'zentaoContext'
            ? { getSnapshot: () => ({ productId: '12', productTitle: '产品A', executionId: '34' }) }
            : undefined),
        },
      },
    }),
  }
  const { rec, React, ctx } = applyClient({ sessions })
  const tree = React.render(dockOf(rec), { t: makeT(), ctx, sessionId: 's1' })
  const text = flatten(tree).join(' ')
  assert.match(text, /产品A/)
  assert.match(text, /34/)
})

test('会话卡片：投影读取抛错时必须被吞掉（宿主对象形状变化不能让卡片崩）', () => {
  const sessions = { binding: () => { throw new Error('shape changed') } }
  const { rec, React, ctx } = applyClient({ sessions })
  assert.doesNotThrow(() => React.render(dockOf(rec), { t: makeT(), ctx, sessionId: 's1' }))
})

test('会话卡片：查看看板失败时显示错误而不是崩', async () => {
  const sessions = { binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => ({ executionId: '34' }) }) } } }) }
  const { rec, React, ctx } = applyClient({
    sessions,
    execute: async () => ({ ok: false, error: { message: '会话不可用', code: 'gateway/cancelled' } }),
  })
  const props = { t: makeT(), ctx, sessionId: 's1' }
  let tree = React.render(dockOf(rec), props)
  // 展开：折叠态里的"展开"按钮
  const expand = collect(tree).find((element) => element.type === 'button' && element.props?.children === 't:expand')
  assert.ok(expand, '应有展开按钮')
  await expand.props.onClick()
  tree = React.render(dockOf(rec), props)
  const refresh = collect(tree).find((element) => element.type === 'button' && element.props?.children === 't:refresh')
  assert.ok(refresh, '展开后应有刷新按钮')
  await refresh.props.onClick()
  tree = React.render(dockOf(rec), props)
  assert.match(flatten(tree).join(' '), /会话不可用/)
})
