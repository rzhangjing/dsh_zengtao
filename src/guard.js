/**
 * 写入门禁：把 `tools/pre-execute` 接到纯函数的决策表上。
 *
 * 已核验的契约（`dsh-tools/lib/types/index.js:1093-1131` serviceAsk）：
 *   - 决策形状：`{ kind:'allow' }` | `{ kind:'deny', reason, info? }`
 *     | `{ kind:'ask', reason?, displayReason? }`
 *   - `ask` 会把 `reason` / `displayReason` 传给 `ctx.approval.request({...})`；
 *   - **approval 服务缺失、或调用没有 agent 时，`ask` 会被自动判为 deny**（fail-closed）；
 *   - `info` 只在 `deny` 时被消费（作为结构化 ToolErrorInfo）。
 *
 * 因此这里的职责很薄：判定 + 组装中文文案 + 交给框架去问人。
 * 决策逻辑本身在 `domain/policy.js`（纯函数，已单测）。
 */

import { CODES, ZenTaoError, redact } from './domain/errors.js'
import { classifyCall, decideWrite, denyReason, renderIntent } from './domain/policy.js'

/**
 * @param {object} ctx
 * @param {() => object} getConfig 配置快照
 * @returns {() => void} disposer
 */
export function registerWriteGuard (ctx, getConfig) {
  const listener = async (exec, next) => {
    const args = exec?.arguments ?? {}
    const cls = classifyCall(exec?.name, args)
    const decision = decideWrite(getConfig().writePolicy, cls)
    if (decision === null) return next()

    const label = cls.actionLabel ?? cls.action ?? '写入'
    const target = cls.id ? `${cls.entity ?? '对象'} #${cls.id}` : (cls.entity ?? '新对象')

    if (decision === 'deny') {
      return {
        kind: 'deny',
        reason: denyReason(getConfig().writePolicy),
        info: { name: 'zentao-write-disabled', code: 'WRITE_DISABLED' },
      }
    }

    if (decision === 'ask') {
      const summary = renderIntent(cls, args)
      const risky = cls.isDelete
        ? '⚠️ 这是**删除**操作，禅道上通常不可撤销。'
        : cls.isBulk
          ? `⚠️ 这是**批量**操作（${cls.bulkCount} 项）。`
          : ''
      return {
        kind: 'ask',
        reason: `禅道${label}：${target}${risky ? ` ${risky}` : ''}`,
        displayReason: [
          summary,
          risky,
          'dryRun=false，确认后将真实写入禅道。',
        ].filter(Boolean).join('\n'),
      }
    }

    return next()
  }

  return ctx.on('tools/pre-execute', listener)
}

/** 供工具层复用：把服务抛出的错误转成工具结果文本。 */
export function errorText (error) {
  if (error instanceof ZenTaoError) return error.toText()
  const message = error?.message ?? String(error)
  return `[${CODES.INTERNAL}] ${redact(message)}\n建议：请把该错误与 /zentao doctor 的输出一起反馈。`
}
