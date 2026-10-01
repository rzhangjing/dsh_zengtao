/**
 * 归一化：把禅道原始载荷转成上层只见的稳定形状。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 * 设计依据：design/02-detailed-design.md §5.1 与 §7.4「归一化的实证陷阱」。
 *
 * §7.4 的每一条都在这里有对应处理，且都有单测覆盖：
 *   1. 状态代码 vs 文档标签不一致 → statusCode 用原始代码，标签仅展示
 *   2. `0000-00-00` 伪装成有效日期   → cleanDate 视为缺失
 *   3. 可空日期（null）              → cleanDate 视为缺失
 *   4. 时间是 UTC ISO-8601           → 原样透传
 *   5. 用户字段既嵌套又扁平          → pickUser 优先嵌套，取 realname ?? account
 *   6. 状态/优先级是代码             → 保留代码，另附中文标签
 *   7. id 是数字                     → toId 一律转字符串
 */

import { labelForPriority, labelForStatus } from './model.js'

/** 一律转字符串的 id（避免 JS 数字精度问题，也避免模型对"数字"做算术）。 */
export function toId (value) {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

/** 数字字段：非数字一律 undefined（不要 NaN 漏进结果）。 */
export function toNumber (value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const ZERO_DATE_RE = /^0{4}-0{2}-0{2}([ T]0{2}:0{2}:0{2})?/

/**
 * 日期清洗。**这是 §7.4 的第 2、3 条陷阱**：
 * `"0000-00-00"` 与 `null` 都必须变成"缺失"，绝不当作真实日期。
 */
export function cleanDate (value) {
  if (value === undefined || value === null) return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  if (typeof value === 'number') {
    // 禅道正常返回字符串；数字只做防御性处理，且不猜单位以外的语义。
    if (value > 1e11) return new Date(value).toISOString()
    if (value > 1e9) return new Date(value * 1000).toISOString()
    return undefined
  }
  const text = String(value).trim()
  if (text === '' || text === '0' || text.toLowerCase() === 'null') return undefined
  if (ZERO_DATE_RE.test(text)) return undefined
  // ISO-8601（带 Z 或带偏移）：v1 的正常形状，原样透传（UTC，无需换算）。
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(text)) return text
  // 纯日期：保留。
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  // `YYYY-MM-DD HH:mm:ss`（legacy 风格的本地时间，无时区）：规范成 T 分隔但不伪造时区。
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text.replace(' ', 'T')
  return text
}

/** 状态代码归一：小写、去空白、空白转连字符。过滤一律用它，保证与线上一致。 */
export function toStatusCode (raw) {
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  if (text === '') return undefined
  return text.toLowerCase().replace(/\s+/g, '-')
}

/**
 * 用户引用归一。**§7.4 第 5 条**：同一载荷里既有嵌套对象
 * `assignedTo: {id, account, realname}`，也有扁平 `assignedToRealName`，
 * 优先用嵌套对象（含 id，便于后续写操作指派）。
 */
export function pickUser (value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object') {
    const id = toId(value.id)
    const name = value.realname ?? value.name ?? value.account ?? id
    if (id === undefined && name === undefined) return undefined
    return { id, name: name === undefined ? undefined : String(name), account: value.account }
  }
  const text = String(value).trim()
  if (text === '' || text === '0') return undefined
  return { name: text }
}

/** 剥掉 HTML 标签、脚本与样式，并折叠空白。 */
export function stripHtml (input) {
  if (input === undefined || input === null) return ''
  let text = String(input)
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/&nbsp;/gi, ' ')
  text = text.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
  text = text.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 有界正文摘要。禅道正文是**不可信数据**（§5.3），
 * 默认 'strip'；'keep' 时也仍然截断，并由渲染层加数据围栏。
 */
export function excerpt (input, { mode = 'strip', max = 400 } = {}) {
  if (input === undefined || input === null) return undefined
  const text = mode === 'keep' ? String(input) : (mode === 'text' ? String(input).replace(/<[^>]+>/g, ' ') : stripHtml(input))
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed
}

/** 只保留列入白名单的实体特有字段，避免把整个载荷灌给模型。 */
const EXTRA_KEYS = Object.freeze([
  'resolution', 'build', 'stage', 'category', 'type', 'subStatus', 'color',
  'closedReason', 'keywords', 'module', 'mailto', 'fromBug', 'storyVersion',
  'finishedBy', 'closedBy', 'resolvedBy', 'testtask', 'caseVersion',
])

/**
 * 取用户字段，**嵌套优先且"存在即权威"**。
 *
 * 为什么不是简单的 `a ?? b`：禅道同一个载荷里既有 `assignedTo: {...}` 又有扁平的
 * `assignedToRealName: "administrator"`。当 `assignedTo` **显式为 null** 时含义是
 * "未指派"，此时回落到扁平字段会把一个未指派的任务显示成指派给了别人 ——
 * 这正是"看起来成功其实是错的"那类静默错误。所以：
 *   嵌套键**存在**（哪怕值是 null）就用它；只有嵌套键**缺失**时才看扁平键。
 */
function pickUserField (raw, nestedKeys, flatKeys) {
  for (const key of nestedKeys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return pickUser(raw[key])
  }
  for (const key of flatKeys) {
    if (raw[key] !== undefined) return pickUser(raw[key])
  }
  return undefined
}

function refIf (value, entity) {
  const id = toId(value)
  if (id === undefined || id === '0') return undefined
  return { entity, id }
}

function buildExtra (raw) {
  const extra = {}
  for (const key of EXTRA_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'object') {
      const user = pickUser(value)
      if (user) extra[key] = user
      continue
    }
    extra[key] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

/**
 * 单条实体归一化。
 * @param {string} entity
 * @param {Record<string, unknown>} raw
 * @param {{ webLink?: (entity: string, id: string) => string, excerptMode?: string }} options
 */
export function normalizeItem (entity, raw, options = {}) {
  if (raw === null || typeof raw !== 'object') {
    return { ref: { entity, id: undefined }, title: String(raw ?? ''), statusCode: undefined, statusLabel: '（无状态）' }
  }
  const id = toId(raw.id)
  const rawStatus = raw.status ?? raw.state
  const assignee = pickUserField(raw, ['assignedTo', 'assigned'], ['assignedToRealName', 'assignedToName'])
  const openedBy = pickUserField(raw, ['openedBy', 'createdBy'], ['openedByRealName', 'createdByRealName'])
  const item = {
    ref: { entity, id },
    title: String(raw.name ?? raw.title ?? raw.realname ?? (id ? `#${id}` : '（无标题）')),
    statusCode: toStatusCode(rawStatus),
    statusLabel: labelForStatus(entity, rawStatus),
    assignee,
    openedBy,
    createdAt: cleanDate(raw.openedDate ?? raw.createdDate ?? raw.createdAt ?? raw.openedAt),
    updatedAt: cleanDate(raw.lastEditedDate ?? raw.updatedDate ?? raw.editedDate ?? raw.updatedAt),
    dueDate: cleanDate(raw.deadline ?? raw.dueDate),
    priority: toNumber(raw.pri ?? raw.priority),
    priorityLabel: labelForPriority(toNumber(raw.pri ?? raw.priority)),
    severity: toNumber(raw.severity),
    estimate: toNumber(raw.estimate),
    consumed: toNumber(raw.consumed),
    left: toNumber(raw.left),
    progress: toNumber(raw.progress),
    product: refIf(raw.product, 'product'),
    project: refIf(raw.project, 'project'),
    execution: refIf(raw.execution, 'execution'),
    story: refIf(raw.story, 'story'),
    // 乐观并发校验要用（§9.3 ②）
    version: raw.version,
  }
  // 软删除标记（实测：真实禅道 `DELETE` 是软删除，详情仍可读但 `deleted` 为 true）。
  // 删除的回读校验依赖它，所以必须归一化出来。
  if (raw.deleted !== undefined && raw.deleted !== null) {
    item.deleted = raw.deleted === true || raw.deleted === 1 || raw.deleted === '1'
  }
  const parentId = toId(raw.parent)
  if (parentId !== undefined && parentId !== '0') item.parent = { entity, id: parentId }
  const text = excerpt(raw.desc ?? raw.description ?? raw.spec ?? raw.steps, { mode: options.excerptMode })
  if (text !== undefined) item.excerpt = text
  if (typeof options.webLink === 'function' && id !== undefined) {
    const url = options.webLink(entity, id)
    if (url) item.url = url
  }
  const extra = buildExtra(raw)
  if (extra !== undefined) item.extra = extra
  return item
}

/**
 * 容错地取出列表数组。
 * 禅道列表响应形如 `{ page, total, limit, products: [...] }`（已核验），
 * 但不同实体的数组键名不全都已核验，故：先按声明的复数键取，
 * 取不到就取**第一个数组值**，再取不到才放弃。这样不必猜键名也能工作。
 */
export function pickArray (json, preferredKey) {
  if (Array.isArray(json)) return json
  if (json === null || typeof json !== 'object') return []
  if (Array.isArray(json[preferredKey])) return json[preferredKey]
  for (const value of Object.values(json)) {
    if (Array.isArray(value)) return value
  }
  return []
}

/**
 * 容错地取出分页元数据。响应里的分页字段是已核验的（page/total/limit）。
 */
export function pickPageMeta (json, fallback = {}) {
  if (json === null || typeof json !== 'object') return { ...fallback }
  return {
    page: toNumber(json.page) ?? fallback.page,
    total: toNumber(json.total) ?? fallback.total,
    limit: toNumber(json.limit) ?? fallback.limit,
  }
}

/**
 * 详情响应可能是裸对象，也可能被包一层。已实测的包装键：
 *   · `{ products: {...} }` / `{ product: {...} }` —— 集合名或实体名单数形式
 *   · `{ data: {...} }` / `{ item: {...} }`
 *   · **`{ profile: {...} }`** —— 真实禅道 `GET /api.php/v1/user` 就是这么包的
 *     （实测：`{"profile":{"id":"2","account":"admin","realname":"admin",…}}`）。
 *     `profile` 放在候选表**最后**：它只对"当前用户"有意义，别让它抢先去解包别的实体。
 */
export function unwrapItem (json, entity, pluralKey) {
  if (json === null || typeof json !== 'object') return json
  if (Array.isArray(json)) return json[0] ?? null
  if (json.id !== undefined) return json
  const candidates = [pluralKey, entity, 'data', 'item', 'profile']
  for (const key of candidates) {
    const value = json[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) return value[0] ?? null
    if (typeof value === 'object') return value
  }
  return json
}
