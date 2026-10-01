/**
 * 查询构建、过滤、排序、投影 —— 全部在**本地**完成。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 *
 * 为什么过滤放在本地（**已实测确认的**设计取舍，design §7.6 的产物）：
 *   禅道 v1 的**响应侧**信封已核验（`{page,total,limit,<复数>}`）；**请求侧**的实测结论是：
 *     - 分页只认 `page` 与 `limit`（`recPerPage`/`perPage`/`pageSize` 全被忽略）；
 *     - **过滤参数根本不存在** —— `q`/`title`/`assignedTo`/`keywords`/`browseType`/`pri`/`severity`
 *       传不可能匹配的值仍返回全部；而 `status` 会把结果**清空**（传真实状态也返回 0 条）。
 *   所以本地过滤不是"暂时这样"，而是**这个接口下唯一可行的做法**。本插件：
 *     - 只向服务端发送**实体限定**（路径里的 product/execution id）与分页参数；
 *     - 所有 status/assignee/keyword/日期 过滤一律在本地做，且**从不发送 `status`**。
 *   代价是要多扫几页，因此扫描页数有硬上限，达到上限时如实返回 PARTIAL
 *   （见 service.js 的 scan 逻辑），绝不假装"没有更多"。
 */

/** 允许的过滤键（ASCII）；其余一律拒绝并列出可用项。 */
export const FILTER_KEYS = Object.freeze([
  'status', 'assignee', 'openedBy', 'keyword', 'updatedSince', 'dueBefore', 'priority', 'overdue',
])

/** 允许的排序键（ASCII）。 */
export const ORDER_KEYS = Object.freeze([
  'updated_desc', 'updated_asc', 'created_desc', 'created_asc',
  'priority_asc', 'priority_desc', 'due_asc', 'due_desc', 'id_desc', 'id_asc',
])

function toArray (value) {
  if (value === undefined || value === null || value === '') return undefined
  return Array.isArray(value) ? value.map((v) => String(v)) : [String(value)]
}

/**
 * 校验并归一化过滤条件。
 * 未知键直接报错（中文列出可用项）—— 让模型立刻知道该怎么改，而不是静默忽略。
 */
export function normalizeFilters (input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('filters 必须是一个对象。')
  }
  const unknown = Object.keys(input).filter((key) => !FILTER_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(`filters 里不认识的键：${unknown.join('、')}。可用键：${FILTER_KEYS.join('、')}。`)
  }
  const out = {}
  const status = toArray(input.status)
  if (status) out.status = status.map((s) => s.trim().toLowerCase().replace(/\s+/g, '-'))
  // assignee / openedBy 在这里**只接受字符串**：数组形态是插件内部（「我的」）用的精确匹配，
  // 而 `String([...])` 会把它变成一个逗号串再去匹配 —— 那会静默地一条都匹配不到。
  for (const key of ['assignee', 'openedBy']) {
    const value = input[key]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      throw new Error(
        `filters.${key} 只接受字符串。要按多个用户匹配请分别查询；` +
        '（数组形态是插件内部精确匹配专用，不对外暴露）',
      )
    }
    out[key] = String(value).trim()
  }
  if (input.keyword !== undefined) out.keyword = String(input.keyword).trim().toLowerCase()
  if (input.updatedSince !== undefined) out.updatedSince = String(input.updatedSince).trim()
  if (input.dueBefore !== undefined) out.dueBefore = String(input.dueBefore).trim()
  const priority = toArray(input.priority)
  if (priority) out.priority = priority.map((p) => Number(p)).filter((n) => Number.isFinite(n))
  if (input.overdue !== undefined) out.overdue = Boolean(input.overdue)
  return out
}

/** 校验排序键。 */
export function normalizeOrderBy (orderBy) {
  if (orderBy === undefined || orderBy === null || orderBy === '') return 'updated_desc'
  const key = String(orderBy).trim()
  if (!ORDER_KEYS.includes(key)) {
    throw new Error(`不认识的 orderBy "${key}"。可用值：${ORDER_KEYS.join('、')}。`)
  }
  return key
}

/**
 * 模糊匹配用户（**人类输入**的半截名字用这个）。
 * 注意：子串匹配会误命中（"李四" 命中 "李四四"），所以它只用于调用方明确输入的
 * 关键词式过滤，**不用于**插件自己判定"我"是谁 —— 那必须用 userMatchesExact。
 */
function userMatches (user, needle) {
  if (!user) return false
  const lower = needle.toLowerCase()
  const name = (user.name ?? '').toLowerCase()
  const account = (user.account ?? '').toLowerCase()
  const id = String(user.id ?? '')
  return name.includes(lower) || account.includes(lower) || id === needle
}

/**
 * 精确匹配用户（**插件内部**判定身份用，例如「我的」）。
 * 只在 name / account / id 上做等值比较，绝不子串匹配 ——
 * 否则"我的待办"会混进别人的条目，而这种错误用户很难察觉。
 */
function userMatchesExact (user, needle) {
  if (!user) return false
  const raw = String(needle ?? '').trim()
  if (raw === '') return false
  const lower = raw.toLowerCase()
  const name = String(user.name ?? '').trim().toLowerCase()
  const account = String(user.account ?? '').trim().toLowerCase()
  const id = String(user.id ?? '').trim()
  return (name !== '' && name === lower) || (account !== '' && account === lower) || (id !== '' && id === raw)
}

function dateAfter (value, threshold) {
  if (!value) return false
  return String(value) >= String(threshold)
}

function dateBefore (value, threshold) {
  if (!value) return false
  return String(value) <= String(threshold)
}

/** 按条件形态选择匹配方式：数组 → 精确（任一命中），字符串 → 模糊。 */
function matchesUserField (user, condition) {
  if (Array.isArray(condition)) {
    const needles = condition.filter((needle) => typeof needle === 'string' && needle.trim() !== '')
    if (needles.length === 0) return false
    return needles.some((needle) => userMatchesExact(user, needle))
  }
  return userMatches(user, condition)
}

/**
 * 判断一条归一化条目是否满足过滤条件。
 *
 * `assignee` / `openedBy` 有两种形态，语义刻意不同：
 *   · **字符串** → 模糊匹配（调用方输入的关键词）
 *   · **数组**   → 逐个**精确**匹配，命中任一即可（插件内部判定身份用，例如「我的」）
 */
export function matchesFilters (item, filters, today) {
  if (filters.status && filters.status.length > 0) {
    if (!item.statusCode || !filters.status.includes(item.statusCode)) return false
  }
  if (filters.assignee !== undefined && filters.assignee !== '') {
    if (!matchesUserField(item.assignee, filters.assignee)) return false
  }
  if (filters.openedBy !== undefined && filters.openedBy !== '') {
    if (!matchesUserField(item.openedBy, filters.openedBy)) return false
  }
  if (filters.keyword) {
    const haystack = [item.title, item.excerpt, item.ref?.id]
      .filter(Boolean).join(' ').toLowerCase()
    if (!haystack.includes(filters.keyword)) return false
  }
  if (filters.updatedSince !== undefined && !dateAfter(item.updatedAt, filters.updatedSince)) return false
  if (filters.dueBefore !== undefined) {
    if (!item.dueDate) return false
    if (!dateBefore(item.dueDate, filters.dueBefore)) return false
  }
  if (filters.priority && filters.priority.length > 0) {
    if (!filters.priority.includes(item.priority)) return false
  }
  if (filters.overdue) {
    if (!item.dueDate || !today) return false
    if (String(item.dueDate) >= String(today)) return false
    // 已完成/已关闭的不算逾期
    if (item.statusCode && ['done', 'closed', 'cancel', 'resolved'].includes(item.statusCode)) return false
  }
  return true
}

/** 一条条按过滤条件筛选。 */
export function filterItems (items, filters, today) {
  if (!filters || Object.keys(filters).length === 0) return items
  return items.filter((item) => matchesFilters(item, filters, today))
}

function compareNullable (a, b) {
  if (a === b) return 0
  if (a === undefined || a === null) return 1
  if (b === undefined || b === null) return -1
  return a < b ? -1 : 1
}

/** 排序。null/undefined 一律排在后面（不要让"没有截止日"占了首屏）。 */
export function sortItems (items, orderBy) {
  const sorted = [...items]
  const idNum = (item) => {
    const n = Number(item.ref?.id)
    return Number.isFinite(n) ? n : -1
  }
  const cmp = {
    updated_desc: (a, b) => compareNullable(b.updatedAt, a.updatedAt),
    updated_asc: (a, b) => compareNullable(a.updatedAt, b.updatedAt),
    created_desc: (a, b) => compareNullable(b.createdAt, a.createdAt),
    created_asc: (a, b) => compareNullable(a.createdAt, b.createdAt),
    priority_asc: (a, b) => compareNullable(a.priority, b.priority),
    priority_desc: (a, b) => compareNullable(b.priority, a.priority),
    due_asc: (a, b) => compareNullable(a.dueDate, b.dueDate),
    due_desc: (a, b) => compareNullable(b.dueDate, a.dueDate),
    id_desc: (a, b) => idNum(b) - idNum(a),
    id_asc: (a, b) => idNum(a) - idNum(b),
  }[orderBy] ?? ((a, b) => compareNullable(b.updatedAt, a.updatedAt))
  return sorted.sort(cmp)
}

/** 始终保留的核心字段（投影时不可丢）。 */
const ALWAYS_KEEP = Object.freeze(['ref', 'title', 'statusCode', 'statusLabel', 'url'])

/**
 * 字段投影：只留调用方点名的字段（外加核心字段）。
 * 用于省 token；未知字段名不报错（禅道字段名随版本变化，报错反而阻碍使用）。
 */
export function applyProjection (items, fields) {
  if (!fields || fields.length === 0) return items
  const keep = new Set([...ALWAYS_KEEP, ...fields])
  return items.map((item) => {
    const out = {}
    for (const [key, value] of Object.entries(item)) {
      if (keep.has(key) && value !== undefined) out[key] = value
    }
    return out
  })
}

/** 本地分页（配合 service 的多页扫描）。 */
export function paginateLocally (items, page, pageSize) {
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    totalMatched: items.length,
    hasMore: start + pageSize < items.length,
  }
}
