/**
 * 禅道插件的错误分类与脱敏。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`，因此可以用普通 node 离线单测。
 * 设计依据：design/02-detailed-design.md §12（错误码表）与 §4.3（脱敏规则）。
 */

/** 全部错误码（ASCII，机器可读；给模型看的说明一律中文）。 */
export const CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED: 'UNSUPPORTED',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  AMBIGUOUS: 'AMBIGUOUS',
  PARTIAL: 'PARTIAL',
  INTERNAL: 'INTERNAL',
})

/** 每个错误码给模型看的下一步提示（中文）。 */
const HINTS = Object.freeze({
  AUTH_REQUIRED: '请让用户运行 /zentao login，或在设置页填入禅道 API Token。',
  AUTH_EXPIRED: '禅道拒绝了该 Token（可能已失效）。请重新获取 Token 并填入设置页。',
  FORBIDDEN: '当前禅道账号没有该操作的权限，不要重试。',
  NOT_FOUND: '对象不存在。请确认 id 是否正确，可先用 zentao_query 检索。',
  // 真实禅道的 400 有两类常见原因：**缺少必填字段**（最常遇到，服务端消息会点名，例如
  // 「『类别』不能为空。」）与**状态转换不合法**。hint 必须把两者都说到 ——
  // 原先只提"状态转换"会把用户引向错误方向（实测踩到过）。
  VALIDATION: '禅道拒绝了该字段取值或状态转换。若服务端消息说某个字段「不能为空」，那是**缺少必填字段**' +
    '（实测：需求要 category、开启评审时还要 reviewer；Bug 要 type；解决 Bug 要 resolution 与 resolvedBuild），' +
    '补上再试；否则先用 zentao_get 查看当前状态再决定。',
  CONFLICT: '对象已被他人修改（版本冲突）。请重新读取后再决定，不要直接覆盖。',
  RATE_LIMITED: '禅道侧限流。请稍后重试，或缩小查询范围。',
  UNSUPPORTED: '当前禅道版本或接口不支持该能力，已在诊断信息里列出探测事实。',
  NETWORK: '网络不可达。请确认 baseURL、DNS 与代理设置。',
  TIMEOUT: '请求超时。可缩小查询范围，或调大 requestTimeoutMs。',
  AMBIGUOUS: '匹配到多条候选，需要用户确认具体是哪一个。',
  PARTIAL: '部分数据获取失败，本次结果不完整，请勿据此判断总量。',
  INTERNAL: '插件内部错误，请把这个错误码反馈给插件维护者。',
})

/** 禅道 HTTP 状态码 → 错误码的兜底映射。 */
const STATUS_TO_CODE = Object.freeze({
  400: CODES.VALIDATION,
  401: CODES.AUTH_EXPIRED,
  403: CODES.FORBIDDEN,
  404: CODES.NOT_FOUND,
  405: CODES.UNSUPPORTED,
  409: CODES.CONFLICT,
  415: CODES.VALIDATION,
  422: CODES.VALIDATION,
  429: CODES.RATE_LIMITED,
  500: CODES.INTERNAL,
  502: CODES.NETWORK,
  503: CODES.NETWORK,
  504: CODES.TIMEOUT,
})

export function codeForStatus (status) {
  if (STATUS_TO_CODE[status]) return STATUS_TO_CODE[status]
  if (status >= 500) return CODES.INTERNAL
  if (status >= 400) return CODES.VALIDATION
  return CODES.INTERNAL
}

/**
 * 插件统一错误。`message` 面向模型与人（中文），`facts` 面向排障（已脱敏）。
 */
export class ZenTaoError extends Error {
  constructor (code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'ZenTaoError'
    this.code = code
    this.status = options.status
    this.facts = options.facts
    this.details = options.details
    /** 允许调用方覆盖默认 hint（例如把"已探测事实"塞进来）。 */
    this.hint = options.hint ?? HINTS[code] ?? HINTS.INTERNAL
  }

  /** 给 tools/pre-execute 的结构化拒绝信息。 */
  toInfo () {
    return { name: 'zentao', code: this.code, reason: this.toText() }
  }

  /** 工具结果里呈现的文本（含下一步提示）。 */
  toText () {
    const parts = [`[${this.code}] ${this.message}`]
    if (this.hint) parts.push(`建议：${this.hint}`)
    if (this.facts !== undefined) {
      try {
        parts.push(`事实：${JSON.stringify(redact(this.facts))}`)
      } catch {
        parts.push('事实：（无法序列化）')
      }
    }
    return parts.join('\n')
  }
}

/** 把任意异常收敛成 ZenTaoError。 */
export function asZenTaoError (err, fallbackCode = CODES.INTERNAL) {
  if (err instanceof ZenTaoError) return err
  if (err?.name === 'AbortError') {
    return new ZenTaoError(CODES.TIMEOUT, '请求被取消或超时。', { cause: err })
  }
  const message = err?.message ? String(err.message) : '未知错误'
  return new ZenTaoError(fallbackCode, redact(message), { cause: err })
}

/* ────────────────────────────── 脱敏 ────────────────────────────── */

/** 命中即整体替换为 "***" 的字段名。 */
export const SECRET_KEY_RE = /(token|password|passwd|secret|sid|cookie|authorization|credential)/i

/** 出境前必须剔除的响应头（小写比较）。 */
export const SECRET_HEADERS = Object.freeze([
  'set-cookie', 'cookie', 'authorization', 'token', 'x-zentao-token', 'proxy-authorization',
])

/** URL query 里必须抹掉的参数名（小写比较）。 */
const SECRET_QUERY_KEYS = Object.freeze(['token', 'zentaosid', 'password', 'passwd', 'secret'])

/**
 * 深度脱敏：命中敏感键名整体替换、截断超长字符串、限制数组长度与深度。
 * 返回值一定是可 JSON 序列化的纯数据。
 */
export function redact (value, options = {}) {
  const maxDepth = options.maxDepth ?? 6
  const maxArray = options.maxArray ?? 20
  const maxString = options.maxString ?? 500
  const seen = new WeakSet()

  const walk = (node, depth) => {
    if (node === null || node === undefined) return node
    const type = typeof node
    if (type === 'string') {
      return node.length > maxString ? `${node.slice(0, maxString)}…（已截断）` : node
    }
    if (type === 'number' || type === 'boolean') return node
    if (type === 'bigint') return String(node)
    if (type === 'function' || type === 'symbol') return `[${type}]`
    if (type !== 'object') return String(node)
    if (node instanceof Error) return `[${node.name}] ${node.message}`
    if (seen.has(node)) return '[circular]'
    if (depth >= maxDepth) return '[max-depth]'
    seen.add(node)

    if (Array.isArray(node)) {
      const out = node.slice(0, maxArray).map((item) => walk(item, depth + 1))
      if (node.length > maxArray) out.push(`…还有 ${node.length - maxArray} 项`)
      return out
    }

    const out = {}
    for (const [key, item] of Object.entries(node)) {
      out[key] = SECRET_KEY_RE.test(key) ? '***' : walk(item, depth + 1)
    }
    return out
  }

  return walk(value, 0)
}

/** 抹掉 URL 里的敏感 query 参数，保留其余部分便于排障。 */
export function redactUrl (url) {
  if (typeof url !== 'string') return url
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.includes(key.toLowerCase())) parsed.searchParams.set(key, '***')
    }
    return parsed.toString()
  } catch {
    // 不是合法 URL：用最保守的正则兜底
    return url.replace(/([?&](?:token|zentaosid|password|passwd|secret)=)[^&#]*/gi, '$1***')
  }
}

/** 只保留出境的响应头白名单，并脱敏。 */
export function redactHeaders (headers) {
  const out = {}
  if (!headers) return out
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers)
  for (const [key, value] of entries) {
    const lower = String(key).toLowerCase()
    if (SECRET_HEADERS.includes(lower)) {
      out[lower] = '***'
      continue
    }
    out[lower] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value
  }
  return out
}
