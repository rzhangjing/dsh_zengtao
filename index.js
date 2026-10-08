/**
 * Host 半入口。
 *
 * 设计要点：
 *   - `inject = ['tools']` 是唯一**必需**依赖：没有工具注册表，本插件没有意义。
 *   - 其余服务（credentials / authorization / storageDomain / commands / skills /
 *     sessionProjections / systemPrompt / agents）全部**惰性获取**：
 *     缺失时相关功能降级或跳过，而不是让插件加载失败。
 *   - 所有注册都显式放进 `ctx.effect`（工具/命令/技能/提示词段/门禁/授权流/会话投影），
 *     因此插件卸载或 HMR 重载时会主动拆除 —— **不依赖宿主服务是否自己跟踪注册**
 *     （这一点是实测出来的，见 design 附录 C.31）。
 */

import { Config, snapshotConfig } from './src/config.js'
import { Transport } from './src/transport/client.js'
import { KeyedQueue } from './src/domain/locks.js'
import { createService } from './src/service.js'
import { createStore } from './src/store.js'
import { createTokenSource, describeAuth, registerAuthorizationFlow, resolveAccount } from './src/auth.js'
import { registerTools } from './src/tools.js'
import { registerWriteGuard } from './src/guard.js'
import { registerCommands } from './src/commands.js'
import { registerZentaoSkill } from './src/skill.js'
import { registerZentaoPrompt } from './src/prompt.js'
import { createSessionContext, currentSessionId, registerZentaoProjection } from './src/projection.js'

export const name = 'zentao'

/** 必需依赖：工具注册表。 */
export const inject = ['tools']

export { Config }

export function apply (ctx, config) {
  const log = (message) => {
    try {
      console.warn(`[zentao] ${message}`)
    } catch { /* 忽略日志失败 */ }
  }
  const getConfig = () => snapshotConfig(config)

  const transport = new Transport({
    getTimeoutMs: () => getConfig().requestTimeoutMs,
    getMaxRetries: () => getConfig().maxRetries,
  })
  const locks = new KeyedQueue()
  const store = createStore(ctx, log)
  const sessionContext = createSessionContext()

  // 认证：凭据库里的**账号 + 密码** → 换取 API Token（只缓存在内存）→ 401 时自动失效重换。
  // tokenSource 在 service 之后创建（它需要 service.exchangeToken），所以这里先用闭包延迟取值。
  let tokenSource
  const service = createService({
    transport,
    store,
    locks,
    getConfig,
    getToken: () => tokenSource.get(),
    onAuthFailure: () => tokenSource?.invalidate(),
    describeAuth: () => describeAuth(ctx, getConfig()),
    getStartupFailures: () => startupFailures,
    // v2 没有「当前用户」端点，账号来自凭据（严格 v2-only 下不发 v1 请求）
    getAccount: () => resolveAccount(ctx, getConfig()),
    // 单站点 + 会话上下文：工具省略 scope 时用 `/zentao switch` 设过的产品/执行补全
    getSessionContext: () => sessionContext.get(currentSessionId(ctx)),
    logger: log,
  })
  tokenSource = createTokenSource(ctx, getConfig, service)

  // ── 生命周期：关掉 storage domain 句柄 ──
  ctx.effect(() => () => store.close(), 'zentao: storage domain handle')

  /** 幂等拆除：注册服务自己可能也会拆一次，重复调用不能抛错。 */
  const once = (fn) => {
    let done = false
    return () => {
      if (done) return
      done = true
      try { fn?.() } catch { /* 拆除失败不致命，别把卸载流程带崩 */ }
    }
  }

  // ── 启动期注册失败清单 ──
  // 真机事故的**放大器**就是"注册失败被静默吞掉"：提示词变量名非法 → 注册抛错被 catch →
  // 段落却仍引用那个变量 → 每轮组装提示词都报 malformed prompt variable reference。
  // 现在任何注册失败都会：① 写日志 ② 进这份清单 ③ 出现在 `/zentao doctor` 里。
  const startupFailures = []
  const recordStartupFailure = (area, error) => {
    const message = String(error?.message ?? error ?? '未知错误')
    startupFailures.push({ area, message })
    log(`注册失败（${area}）：${message}`)
  }

  // ── L4：工具、写入门禁、命令 ──
  //
  // 每一类注册都显式放进 `ctx.effect`：**不要假设宿主服务会自己清理注册**。
  // 这条是被真机实验逼出来的：把插件加载进真实 Cordis 上下文、再用不跟踪注册的桩服务做宿主，
  // 卸载后工具/命令/技能**都还在**（详见 design 附录 C.31）。真实 dsh-tools 是否按 fiber 跟踪
  // 未能核验，所以这里自己做，代价只有几行。
  ctx.effect(() => {
    // registerTools 只用到 ctx.tools.register，因此传一个只带这一个方法的接收器即可捕获 disposer，
    // 不必改动 tools.js 的内部结构。
    const offs = []
    registerTools({
      tools: {
        register (tool) {
          const off = ctx.tools.register(tool)
          offs.push(off)
          return off
        },
      },
    }, service, getConfig)
    return () => { for (const off of offs) once(off)() }
  }, 'zentao: tools')

  const offGuard = registerWriteGuard(ctx, getConfig)
  ctx.effect(() => once(offGuard), 'zentao: write guard')

  ctx.effect(() => {
    const off = registerCommands(ctx, service, getConfig, sessionContext, tokenSource)
    return once(off)
  }, 'zentao: commands')

  ctx.effect(() => {
    const off = registerZentaoSkill(ctx, log)
    return once(off)
  }, 'zentao: skill')

  const offPrompt = registerZentaoPrompt(ctx, getConfig, {
    onFailure: (area, error) => {
      recordStartupFailure(area, error)
    },
  })
  ctx.effect(() => once(offPrompt ?? (() => {})), 'zentao: prompt section')

  // ── 可选服务：授权流（需要 credentials + authorization）──
  ctx.inject(['credentials', 'authorization'], (child) => {
    try {
      const dispose = registerAuthorizationFlow(child, getConfig())
      child.effect(() => dispose ?? (() => {}), 'zentao: authorization flow')
    } catch (error) {
      log(`注册授权流失败：${error?.message ?? error}`)
    }
  })

  // ── 可选服务：会话投影（当前产品/执行）──
  ctx.inject(['sessionProjections'], (child) => {
    try {
      const dispose = registerZentaoProjection(child, sessionContext)
      child.effect(() => dispose ?? (() => {}), 'zentao: session projection')
    } catch (error) {
      log(`注册会话投影失败：${error?.message ?? error}`)
    }
  })

  log('已加载（工具：zentao_query / zentao_get / zentao_my / zentao_write / zentao_board）')
}
