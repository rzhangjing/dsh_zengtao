/**
 * L1 传输层：HTTP 执行、超时、重试、并发限制、错误收敛。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`（fetch 由调用方注入，便于离线单测）。
 *
 * 两条硬约束（design/01-framework.md §13）：
 *   1. **只用裸 `fetch()`**。DSH 的 `dsh-http-proxy` 已在 launcher 阶段装好全局
 *      dispatcher，会自动读取 http_proxy/https_proxy/no_proxy/all_proxy。
 *      自建 undici `Agent` 当 dispatcher 会**静默绕过**企业代理 —— 明令禁止。
 *   2. **只重试幂等请求**（GET/HEAD）。写操作永不自动重试：靠幂等键 + 写后回读兜底。
 */

import {
  CODES, ZenTaoError, codeForStatus, redact, redactHeaders, redactUrl,
} from '../domain/errors.js'

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** 简单 FIFO 信号量。 */
class Semaphore {
  constructor (limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    this.waiters = []
  }

  async acquire () {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise((resolve) => this.waiters.push(resolve))
    this.active += 1
  }

  release () {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }

  async run (fn) {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/** 读并发 2 / 写并发 1（design §13「单站点串行」）。 */
export function createLimiters ({ reads = 2, writes = 1 } = {}) {
  const readLimiter = new Semaphore(reads)
  const writeLimiter = new Semaphore(writes)
  return {
    read: (fn) => readLimiter.run(fn),
    write: (fn) => writeLimiter.run(fn),
  }
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isIdempotent (method) {
  return IDEMPOTENT_METHODS.has(String(method).toUpperCase())
}

/** 去掉末尾斜杠，保证拼接稳定。 */
export function normalizeBase (baseURL) {
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new ZenTaoError(CODES.VALIDATION, '禅道 baseURL 未配置。请在设置页填写，例如 https://zentao.example.com')
  }
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ZenTaoError(CODES.VALIDATION, `baseURL 不是合法 URL：${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ZenTaoError(CODES.VALIDATION, `baseURL 只允许 http/https，收到：${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ZenTaoError(
      CODES.VALIDATION,
      'baseURL 里不允许内嵌用户名密码。请改用 API Token（凭据引用），不要在 URL 里带凭据。',
    )
  }
  return trimmed
}

/** 拼接 path + query。 */
export function buildUrl (base, path, query) {
  const url = new URL(`${base}${path.startsWith('/') ? '' : '/'}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/** 把调用方 signal 与超时融合成一个 signal。 */
function fuseSignal (signal, timeoutMs) {
  const hasAny = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
  const timeout = timeoutMs > 0 && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  if (!timeout) return signal
  if (!signal) return timeout
  if (hasAny) return AbortSignal.any([signal, timeout])
  // 兜底：手工串联
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  timeout.addEventListener('abort', () => controller.abort(timeout.reason), { once: true })
  return controller.signal
}

function looksLikeTlsProblem (error) {
  const code = String(error?.cause?.code ?? error?.code ?? '')
  const message = String(error?.message ?? '')
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/i.test(code + ' ' + message)
}

function sleep (ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new ZenTaoError(CODES.TIMEOUT, '请求在等待重试时被取消。'))
      }, { once: true })
    }
  })
}

/**
 * 传输器。
 *
 * `request` **不**对非 2xx 抛错，而是把响应交回调用方 —— 这样探测梯才能区分
 * 401（方言对、缺凭据）与 404（方言不对）。这一步的区分是整个探测的关键（§7.5）。
 * 传输层的失败（网络、超时、取消）才抛 ZenTaoError。
 */
export class Transport {
  constructor ({ fetchImpl, getTimeoutMs, getMaxRetries, limiters, logger } = {}) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new ZenTaoError(CODES.INTERNAL, '运行环境没有可用的 fetch。')
    }
    this.getTimeoutMs = getTimeoutMs ?? (() => 20000)
    this.getMaxRetries = getMaxRetries ?? (() => 2)
    this.limiters = limiters ?? createLimiters()
    this.logger = logger
    this.stats = { requests: 0, retries: 0, failures: 0 }
  }

  /**
   * @param {object} spec
   * @param {string} spec.base      已归一化的 baseURL
   * @param {string} spec.path
   * @param {object} [spec.query]
   * @param {string} [spec.method]
   * @param {object} [spec.headers]
   * @param {unknown} [spec.body]
   * @param {AbortSignal} [spec.signal]
   * @returns {Promise<{status:number, ok:boolean, contentType:string, json:unknown, text:string, headers:object, url:string}>}
   */
  async request (spec) {
    const method = String(spec.method ?? 'GET').toUpperCase()
    const idempotent = isIdempotent(method)
    const timeoutMs = this.getTimeoutMs()
    const maxRetries = idempotent ? Math.max(0, this.getMaxRetries()) : 0
    const url = buildUrl(spec.base, spec.path, spec.query)
    const run = idempotent ? this.limiters.read : this.limiters.write

    let attempt = 0
    for (;;) {
      attempt += 1
      this.stats.requests += 1
      const init = {
        method,
        headers: { Accept: 'application/json', ...(spec.headers ?? {}) },
        signal: fuseSignal(spec.signal, timeoutMs),
      }
      if (spec.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)
        if (init.headers['Content-Type'] === undefined) init.headers['Content-Type'] = 'application/json'
      }

      let response
      try {
        response = await run(() => this.fetchImpl(url, init))
      } catch (error) {
        if (spec.signal?.aborted) {
          throw new ZenTaoError(CODES.TIMEOUT, '请求已被调用方取消。', { cause: error })
        }
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        // 幂等请求（写操作的 maxRetries 被强制为 0）对**网络错误与超时**都重试：
        // 瞬时抖动是 GET 的常见失败，重试一次往往就好了。
        if (attempt <= maxRetries) {
          this.stats.retries += 1
          await sleep(this.backoff(attempt), spec.signal)
          continue
        }
        this.stats.failures += 1
        if (isTimeout) {
          throw new ZenTaoError(
            CODES.TIMEOUT,
            `请求超时（${timeoutMs}ms）：${redactUrl(url)}`,
            { cause: error, facts: { method, url: redactUrl(url) } },
          )
        }
        const tls = looksLikeTlsProblem(error)
        throw new ZenTaoError(
          CODES.NETWORK,
          `无法连接禅道：${error?.message ?? error}`,
          {
            cause: error,
            facts: { method, url: redactUrl(url), code: error?.cause?.code ?? error?.code },
            hint: tls
              ? '看起来是 TLS 证书问题。内网自签名证书请**在启动 DSH 之前**设置 NODE_EXTRA_CA_CERTS 指向企业根证书；插件不会关闭证书校验。'
              : undefined,
          },
        )
      }

      const text = await this.readText(response)
      const contentType = String(response.headers?.get?.('content-type') ?? '')
      const json = this.parseJson(text, contentType)

      // 幂等请求遇到可重试状态码 → 退避后重试
      if (idempotent && RETRYABLE_STATUS.has(response.status) && attempt <= maxRetries) {
        this.stats.retries += 1
        const retryAfter = this.retryAfterMs(response)
        await sleep(retryAfter ?? this.backoff(attempt), spec.signal)
        continue
      }

      return {
        status: response.status,
        ok: response.ok === true || (response.status >= 200 && response.status < 300),
        contentType,
        json,
        text,
        headers: redactHeaders(response.headers),
        url: redactUrl(url),
        method,
      }
    }
  }

  /**
   * 把非 2xx 响应转成 ZenTaoError。由方言的 parseError 调用（便于方言定制）。
   */
  static toError (response, { messagePrefix = '禅道请求失败' } = {}) {
    const code = codeForStatus(response.status)
    const detail = extractErrorMessage(response.json, response.text)
    return new ZenTaoError(
      code,
      `${messagePrefix}（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
      { status: response.status, facts: { url: response.url, contentType: response.contentType } },
    )
  }

  backoff (attempt) {
    // 指数退避 + 抖动，避免同步重试把禅道打得更狠
    const base = Math.min(4000, 300 * (2 ** (attempt - 1)))
    return Math.round(base * (0.5 + Math.random() * 0.5))
  }

  retryAfterMs (response) {
    const header = response.headers?.get?.('retry-after')
    if (!header) return undefined
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(30000, seconds * 1000))
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, Math.min(30000, date - Date.now()))
    return undefined
  }

  async readText (response) {
    try {
      return await response.text()
    } catch (error) {
      throw new ZenTaoError(CODES.NETWORK, `读取响应体失败：${error?.message ?? error}`, { cause: error })
    }
  }

  parseJson (text, contentType) {
    if (text === undefined || text === null || text === '') return undefined
    const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(text)
    if (!looksJson) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
}

/**
 * 从响应体里尽力提取人类可读的错误说明。
 * 只取白名单字段名 + **逐字段信封兜底**，绝不把整个响应体塞进错误消息。
 *
 * 真实禅道会返回**两种**错误信封（本机实例实测）：
 *   · 平铺：`{"error":"『类别』不能为空。"}`
 *   · 逐字段：`{"error":{"reviewer":["『评审人』不能为空。"]}}` / `{"error":{"workflowGroup":["「项目流程」不能为空。"]}}`
 * 后者的键名是**任意字段名**，白名单必然漏掉 —— 于是用户只看到干巴巴的 "HTTP 400"。
 * 所以递归时对"认不出的对象"取第一段可读文本作为兜底。
 */
export function extractErrorMessage (json, text, depth = 0) {
  // 纯字符串也能当消息（逐字段信封的值是数组，元素就是字符串）
  if (typeof json === 'string' && json.trim() !== '') {
    const trimmed = json.trim()
    if (/^\s*<(!doctype|html)/i.test(trimmed)) {
      return '返回的是 HTML 页面（通常是登录页或 404 页），不是 JSON 接口响应 —— 请检查 baseURL 与接口地址'
    }
    return redact(trimmed)
  }
  if (json !== undefined && json !== null && typeof json === 'object' && depth < 5) {
    // ① 白名单键优先（形状稳定、语义明确）
    for (const key of ['error', 'message', 'msg', 'reason', 'detail', 'errors']) {
      const value = json[key]
      if (typeof value === 'string' && value.trim() !== '') return redact(value.trim())
      if (value && typeof value === 'object') {
        const nested = extractErrorMessage(value, '', depth + 1)
        if (nested) return nested
      }
    }
    // ② 兜底：逐字段信封（键名是字段名，认不出就取第一段可读文本）
    const values = Array.isArray(json) ? json : Object.values(json)
    for (const value of values) {
      const nested = extractErrorMessage(value, '', depth + 1)
      if (nested) return nested
    }
    return ''
  }
  if (typeof text === 'string' && text.trim() !== '') {
    const trimmed = text.trim()
    if (/^\s*<(!doctype|html)/i.test(trimmed)) {
      return '返回的是 HTML 页面（通常是登录页或 404 页），不是 JSON 接口响应 —— 请检查 baseURL 与接口地址'
    }
    return redact(trimmed.slice(0, 200))
  }
  return ''
}

/**
 * 判定响应是否为 HTML（探测梯与 call() 用来识别"打到了网页而不是接口"）。
 *
 * **响应体形状优先于 Content-Type** —— 这一点是真实禅道纠正过来的：
 * `GET /zentao/api.php/v1` 会返回 `200` + 合法 JSON（`{"error":"EMPTY_ENTRY"}`），
 * 但 `Content-Type` 却是 `text/html; Language=UTF-8;charset=UTF-8`。
 * 只看 Content-Type 的话，这个**完全正常的 JSON 响应**会被误判成网页，
 * 于是本该报"业务错误"的地方报成"你打到了登录页"。
 */
export function looksLikeHtml (response) {
  const markup = typeof response.text === 'string' && /^\s*<(!doctype|html)/i.test(response.text)
  // 能解析成 JSON：只有真的以 HTML 标签开头才算网页（JSON 里不会有裸的 `<html`）
  if (looksLikeJson(response)) return markup
  // 不是 JSON：Content-Type 说 html、或响应体看起来像 HTML 标签，都算网页
  return /html/i.test(response.contentType) || markup
}

/** 判定响应体是否为 JSON 对象/数组。 */
export function looksLikeJson (response) {
  return response.json !== undefined && response.json !== null && typeof response.json === 'object'
}
