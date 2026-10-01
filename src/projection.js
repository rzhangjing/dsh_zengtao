/**
 * 会话上下文：让 `/zentao switch <产品> [执行]` 真正影响后续工具调用的默认范围。
 *
 * 为什么这么实现（诚实说明）：
 *   设计稿希望"当前禅道上下文"完全由**会话日志的既有事件**派生（因为插件不得新增
 *   事件类型）。命令的运行会被记为 `command/run` 与 `command/done`，但**其确切的
 *   负载字段名未能在已安装产物中核验**（README 只说"exact payload fields live in
 *   src/types.ts"，而 lib 里没有可读的字段清单）。
 *   因此这里采用**双轨**：
 *     1) `sessionProjections` 单元折叠 `command/*` 事件 —— 字段名做形状容错，
 *        匹配不到就原样返回同一引用（不会崩、也不会污染状态）；
 *     2) 命令 handler 同时写入**进程内**的会话上下文表 —— 这是可靠的一轨，
 *        面板与工具的默认范围都读它。
 *   待 `command/run` 的字段名确认后，把 2) 去掉即可回到纯日志派生。
 */

import { z } from 'zod'

const commandContextSchema = z.object({
  productId: z.string().optional(),
  executionId: z.string().optional(),
  productTitle: z.string().optional(),
  updatedAt: z.string().optional(),
})

export function createSessionContext () {
  /** @type {Map<string, {productId?:string, executionId?:string, productTitle?:string, updatedAt:string}>} */
  const bySession = new Map()

  return {
    set (sessionId, context) {
      if (!sessionId) return
      bySession.set(String(sessionId), { ...context, updatedAt: new Date().toISOString() })
    },
    get (sessionId) {
      if (!sessionId) return undefined
      return bySession.get(String(sessionId))
    },
    clear (sessionId) {
      if (sessionId) bySession.delete(String(sessionId))
      else bySession.clear()
    },
    size () {
      return bySession.size
    },
  }
}

/** 当前发起者所在的会话 id（Host 侧）。取不到就返回 undefined。 */
export function currentSessionId (ctx) {
  try {
    const agents = ctx.get('agents')
    const initiator = agents?.currentInitiator?.()
    const session = initiator?.session
    const id = session?.header?.id ?? session?.id
    return id === undefined || id === null ? undefined : String(id)
  } catch {
    return undefined
  }
}

/** 产品/执行编号在禅道里就是数字；只接受数字能挡掉绝大多数误命中。 */
const ID = '\\d+'
/** 参数形态：`switch 12 34`（命令名已被宿主剥掉）。锚定两端，避免从长句里抠。 */
const ARG_RE = new RegExp(`^\\s*switch\\s+(${ID})(?:\\s+(${ID}))?\\s*$`)
/** 整行形态：`/zentao switch 12 34`。**必须带命令名**。 */
const LINE_RE = new RegExp(`(?:^|\\s)/?zentao\\s+switch\\s+(${ID})(?:\\s+(${ID}))?(?:\\s|$)`)

/** 逐个候选串尝试两种形态。 */
function matchSwitch (value) {
  if (typeof value !== 'string') return undefined
  const arg = ARG_RE.exec(value)
  if (arg) return { productId: arg[1], executionId: arg[2] }
  const line = LINE_RE.exec(value)
  if (line) return { productId: line[1], executionId: line[2] }
  return undefined
}

/**
 * 从任意 `command/*` 事件的负载里尽力抠出 `switch <product> [execution]`。
 *
 * **只看输入形态的字段，刻意不看 `text`** —— `text` 通常是命令的**输出**，
 * 而 `/zentao help` 的帮助文本里字面就含 `switch <产品id> [执行id]`。
 * 从输出里抠参数会把会话范围设成一个不存在的产品（随后所有省略 scope 的调用
 * 都会查错范围）。宁可派生不出来（还有进程内那一轨可靠兜底），也不要猜出一个错值。
 */
export function extractSwitchFromEvent (event) {
  if (!event || typeof event !== 'object') return undefined
  if (typeof event.type !== 'string' || !event.type.startsWith('command/')) return undefined
  const data = event.data ?? event
  // rawInput/input/arguments/args 是"参数"；line/commandLine 是"整行"。都不含输出。
  for (const value of [data.rawInput, data.input, data.arguments, data.args, data.line, data.commandLine]) {
    const parsed = matchSwitch(value)
    if (parsed) return parsed
  }
  return undefined
}

/**
 * 注册会话投影单元。
 * 契约要求（`dsh-session-projection/README.md:54`）：`apply` 纯同步、忽略的事件
 * 必须返回**同一引用**；`wire.view` 在值不变时应复用引用。
 */
export function registerZentaoProjection (ctx, sessionContext) {
  const sessionProjections = ctx.get('sessionProjections')
  if (!sessionProjections) return undefined

  const definition = {
    key: 'zentaoContext',
    stateSchema: commandContextSchema,
    stateVersion: 1,
    init: () => ({}),
    apply (state, event) {
      const parsed = extractSwitchFromEvent(event)
      if (!parsed) return state // 同一引用 → 零下游开销
      // 值没变就不要造新对象：`command/run` 与 `command/done` 往往带同样的输入，
      // 否则一次 switch 会触发两轮下游刷新。
      if (state.productId === parsed.productId && state.executionId === parsed.executionId) return state
      // 刻意**不写入 updatedAt**：投影必须是日志的纯函数。塞 wall-clock 会让同一份日志
      // 重放出不同状态，而契约要求 `apply` 纯同步、`wire.view` 在值不变时复用引用。
      return { ...state, ...parsed }
    },
    wire: {
      viewSchema: commandContextSchema,
      view: (state) => state,
    },
  }

  const dispose = sessionProjections.register(definition)

  // 兜底轨：把进程内上下文同步进投影可读的地方（面板直接读进程内表即可）。
  return () => {
    try {
      dispose?.()
    } finally {
      sessionContext.clear()
    }
  }
}
