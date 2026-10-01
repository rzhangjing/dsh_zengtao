/**
 * 写入策略决策：把「工具调用 + writePolicy」映射成 allow / ask / deny。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`，因此决策矩阵可以离线单测。
 * 设计依据：design/02-detailed-design.md §9.1 的决策表。
 *
 * 决策表（原文）：
 *   action                          readonly  confirm  trusted
 *   create/update/comment/...        deny      ask      allow
 *   delete                           deny      ask      ask
 *   任何 bulk（>1 项）                 deny      ask      ask
 *   dryRun: true                     allow     allow    allow
 */

import { WRITE_ACTIONS, writeActionOf } from './model.js'

/** 受本门禁管辖的工具名（ASCII）。 */
export const GUARDED_TOOLS = Object.freeze(['zentao_write'])

/**
 * 判定一次工具调用是不是写操作，以及它属于哪一类。
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 */
export function classifyCall (toolName, args = {}) {
  if (!GUARDED_TOOLS.includes(toolName)) {
    return { isWrite: false }
  }
  const action = typeof args.action === 'string' ? args.action : undefined
  const spec = action && WRITE_ACTIONS[action] ? writeActionOf(action) : undefined
  const bulk = Array.isArray(args.bulk) ? args.bulk : undefined
  return {
    isWrite: true,
    action,
    actionLabel: spec?.label,
    entity: typeof args.entity === 'string' ? args.entity : undefined,
    id: args.id === undefined || args.id === null ? undefined : String(args.id),
    dryRun: args.dryRun !== false ? true : false, // 缺省即 dryRun（安全默认）
    isDelete: spec?.destructive === true,
    isBulk: bulk !== undefined && bulk.length > 1,
    bulkCount: bulk?.length ?? 0,
  }
}

/**
 * 决策。
 * @param {'readonly'|'confirm'|'trusted'} policy
 * @param {ReturnType<typeof classifyCall>} cls
 * @returns {'allow'|'ask'|'deny'|null} null 表示"本门禁不管，交给下游"
 */
export function decideWrite (policy, cls) {
  if (!cls?.isWrite) return null
  if (cls.dryRun) return 'allow'
  if (policy === 'readonly') return 'deny'
  if (cls.isDelete || cls.isBulk) return 'ask'
  return policy === 'trusted' ? 'allow' : 'ask'
}

/** 拒绝时给模型的可执行理由（中文）。 */
export function denyReason (policy) {
  return `禅道写入当前被禁用（writePolicy=${policy}）。` +
    '请让用户在禅道设置页把写入策略改为 confirm 或 trusted 后重试。'
}

/**
 * 给用户看的确认摘要：必须说清"将改什么"，
 * 而不是复述参数 JSON（§9.1）。
 */
export function renderIntent (cls, args = {}) {
  const bits = []
  const label = cls.actionLabel ?? cls.action ?? '写入'
  const target = cls.id ? `${cls.entity ?? '对象'} #${cls.id}` : (cls.entity ?? '新对象')
  bits.push(`禅道${label}：${target}`)
  if (cls.isBulk) bits.push(`批量 ${cls.bulkCount} 项`)
  if (cls.action === 'update' && args.payload && typeof args.payload === 'object') {
    const patch = args.payload.patch ?? args.payload
    const keys = Object.keys(patch).filter((k) => k !== 'comment')
    if (keys.length > 0) {
      const preview = keys.slice(0, 6)
        .map((k) => `${k}=${stringifyShort(patch[k])}`)
        .join('、')
      bits.push(`字段：${preview}${keys.length > 6 ? ` 等 ${keys.length} 项` : ''}`)
    }
  }
  if (typeof args.reason === 'string' && args.reason.trim() !== '') {
    bits.push(`理由：${truncate(args.reason, 60)}`)
  }
  return bits.join('；')
}

function stringifyShort (value) {
  if (value === null || value === undefined) return '空'
  if (typeof value === 'object') return Array.isArray(value) ? `[${value.length} 项]` : '{…}'
  return truncate(String(value), 40)
}

function truncate (text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
