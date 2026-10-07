/**
 * L3 领域服务：所有用例的唯一实现（工具、命令、UI 都调它）。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。所有外部依赖（transport / store /
 * locks / 配置快照 / token 读取器）都由调用方注入 —— 这样并发写、幂等、回读、
 * 扫描边界这些**最需要被验证**的逻辑可以完全离线单测。
 *
 * 设计依据：design/02-detailed-design.md §8（工具行为）、§9（写入门禁与并发）、
 *          §13（性能与限额）。
 */

import { CODES, ZenTaoError, asZenTaoError, redact } from './domain/errors.js'
import {
  ENTITIES, ENTERPRISE_ENTITY_KEYS, ENTITY_KEYS, entityOf, writeActionOf,
  WRITE_CREATE_FIELDS, WRITE_UPDATE_FIELDS,
} from './domain/model.js'
import {
  normalizeItem, pickArray, pickPageMeta, toId,
} from './domain/normalize.js'
import {
  applyProjection, filterItems, normalizeFilters, normalizeOrderBy, paginateLocally, sortItems,
} from './domain/query.js'
import { checkVersion, objectKey } from './domain/locks.js'
import { describeProbe, probeDialect, PROBE_VERSION } from './transport/probe.js'
import { dialectOf } from './transport/dialects/index.js'
import { extractErrorMessage, looksLikeHtml } from './transport/client.js'

/** normalizeItem 在既无名称又无编号时使用的占位标题（不是真实用户标识）。 */
const PLACEHOLDER_TITLE = '（无标题）'

/** 扫描硬上限：超过就必须如实报 PARTIAL（绝不假装"没有更多"）。 */
export const SCAN_BOUNDS = Object.freeze({
  maxPagesPerList: 5,
  myMaxProjects: 5,
  myMaxExecutionsPerProject: 5,
  myMaxProducts: 5,
  /** 项目范围看板里，"跨执行取任务"最多覆盖多少个执行（每个 1 个请求）。 */
  boardExecutionsForTasks: 5,
})

/** 幂等窗口（毫秒）。 */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000

/* ─────────────────────── 小工具 ─────────────────────── */

export function stableStringify (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** FNV-1a：稳定、无依赖，够用于幂等键（不是安全用途）。 */
export function fnv1a (text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function idempotencyKey (action, entity, id, payload) {
  return `${action}:${entity}:${id ?? 'new'}:${fnv1a(stableStringify(payload ?? {}))}`
}

function nowMs () {
  return Date.now()
}

function todayIso (date = new Date()) {
  return date.toISOString().slice(0, 10)
}

/* ─────────────────────── 服务 ─────────────────────── */

/**
 * @param {object} deps
 * @param {import('./transport/client.js').Transport} deps.transport
 * @param {object} deps.store          持久化接口（异步；可由 storage domain 或内存 Map 实现）
 * @param {import('./domain/locks.js').KeyedQueue} deps.locks
 * @param {() => object} deps.getConfig  返回配置快照（调用方负责 .get() 取活值）
 * @param {() => Promise<string|undefined>} deps.getToken 取一个可用 Token（认证实现在 auth.js）
 * @param {() => void} [deps.onAuthFailure] 收到 401 时回调：用来丢掉已缓存的 Token，下次自动重换
 * @param {() => Promise<object>} [deps.describeAuth] 诊断用：报告账号/密码凭据是否配置（**不含值**）
 * @param {() => Array<{area: string, message: string}>} [deps.getStartupFailures] 诊断用：启动期注册失败清单
 */
export function createService (deps) {
  const { transport, store, locks, getConfig, getToken, getSessionContext } = deps
  const onAuthFailure = typeof deps.onAuthFailure === 'function' ? deps.onAuthFailure : () => {}
  const describeAuth = deps.describeAuth
  const getStartupFailures = deps.getStartupFailures
  const log = deps.logger ?? (() => {})

  /** 方言实例缓存（探测结论变了就重建）。 */
  let dialectCache

  async function resolveDialect () {
    const config = getConfig()
    if (!config.baseURL) {
      throw new ZenTaoError(CODES.VALIDATION, '还没有配置禅道地址（baseURL）。请在设置页填写。')
    }
    if (config.dialect !== 'auto') {
      if (dialectCache?.id === config.dialect && dialectCache.base === config.baseURL) return dialectCache
      const instance = dialectOf(config.dialect, { base: config.baseURL })
      dialectCache = Object.assign(instance, { base: config.baseURL })
      return dialectCache
    }

    const cached = await store.getProbe()
    if (
      cached
      && cached.baseURL === config.baseURL
      && cached.probeVersion === PROBE_VERSION
      && cached.dialectId
    ) {
      if (dialectCache?.id === cached.dialectId && dialectCache.base === config.baseURL) return dialectCache
      const instance = dialectOf(cached.dialectId, { base: config.baseURL })
      dialectCache = Object.assign(instance, { base: config.baseURL, probe: cached })
      return dialectCache
    }

    const result = await probeDialect({
      transport,
      base: config.baseURL,
      token: await getToken(),
      configured: 'auto',
    })
    await store.setProbe({ ...result, baseURL: config.baseURL, probeVersion: PROBE_VERSION })
    const instance = dialectOf(result.dialectId, { base: config.baseURL })
    dialectCache = Object.assign(instance, { base: config.baseURL, probe: result })
    return dialectCache
  }

  /** 主动重探（`/zentao doctor` 与设置页的"重探方言"按钮用）。 */
  async function reprobe () {
    const config = getConfig()
    const result = await probeDialect({
      transport,
      base: config.baseURL,
      token: await getToken(),
      configured: config.dialect === 'auto' ? 'auto' : config.dialect,
    })
    await store.setProbe({ ...result, baseURL: config.baseURL, probeVersion: PROBE_VERSION })
    dialectCache = undefined
    return result
  }

  async function authHeaders () {
    // getToken 现在会**用凭据库里的账号密码换 Token**（内存缓存）；它自己会在缺凭据时抛
    // AUTH_REQUIRED 并给出可操作提示，所以这里只兜底一种情况：换了但拿不到。
    const token = await getToken()
    if (!token) {
      throw new ZenTaoError(
        CODES.AUTH_REQUIRED,
        '还没有可用的禅道凭据。',
        { hint: '请在设置页填写禅道**账号与密码**（或运行 /zentao login）。' },
      )
    }
    return token
  }

  function webLinkFor (dialect, config, entity, id) {
    if (config.includeWebLinks === false) return undefined
    try {
      return dialect.webLink(config.baseURL, entity, id)
    } catch {
      return undefined
    }
  }

  /**
   * **API 根**：站点地址 + 方言的 API 前缀。
   *
   * 这是必须集中处理的一处：`baseURL` 是站点根（`https://host` 或 `https://host/zentao`），
   * 而接口在它的 `/api.php/v1` 下面。曾经因为没人用方言声明的 `basePath`，
   * 所有请求都发到了 `https://host/products` —— 在真机上会一律 404，
   * 而按路径名匹配的测试桩发现不了。所以：**任何发请求的地方都必须经过这里**。
   */
  function apiBase (dialect, config) {
    const root = String(config.baseURL ?? '').replace(/\/+$/, '')
    const prefix = dialect.basePath ?? ''
    return `${root}${prefix}`
  }

  /**
   * 发一个已认证请求，并把非 2xx / 业务错误 / "根本不是接口"统一抛成 ZenTaoError。
   *
   * `expectJson` 默认为 true；写请求可以传 false，因为 `DELETE` 之类的成功响应
   * 可能合法地是空体（200 + 空 body），不能因此报错。
   */
  async function call ({ dialect, spec, token, what, signal, expectJson = true }) {
    const config = getConfig()
    const response = await transport.request({
      base: apiBase(dialect, config),
      method: spec.method,
      path: spec.path,
      query: spec.query,
      body: spec.body,
      headers: dialect.authHeaders(token),
      signal,
    })
    if (!response.ok) {
      // 401 = 手里的 Token 不再被接受（实测禅道 Token 没有可读的有效期，只留下这个信号）。
      // 先丢掉缓存，这样下一次调用会自动用账号密码重换一个 Token —— 用户不必手动重登。
      if (response.status === 401) onAuthFailure()
      throw dialect.parseError(response, { what })
    }

    // 2xx 但**返回的是网页**：自建禅道最常见的故障 —— baseURL 少了子目录（例如少了 /zentao）、
    // REST API 未启用，或未认证时被登录页以 200 接管。
    // 必须在这里明确报错：否则 `pickArray(undefined)` 会给出空列表，
    // 用户看到的是"0 条结果"这种**静默的错误答案**，比报错难查得多。
    if (looksLikeHtml(response)) {
      throw new ZenTaoError(CODES.UNSUPPORTED, `${what}返回的是网页（HTML）而不是接口数据。`, {
        facts: { url: response.url, contentType: response.contentType, status: response.status },
        hint: '通常是 baseURL 少了禅道的子目录（例如应写成 https://host/zentao），' +
          '或该站点的 REST API 未启用、未认证时被登录页接管。用 /zentao doctor 看探测事实。',
      })
    }

    const businessError = dialect.detectBusinessError(response.json)
    if (businessError) {
      throw new ZenTaoError(CODES.VALIDATION, `${what}被禅道拒绝：${businessError}`, {
        facts: { url: response.url },
      })
    }

    // 2xx、不是网页、也不是任何合法 JSON：同样不能当成"空结果"。
    // 这里刻意不把响应体带进错误信息（登录页里可能有令牌之类的东西）。
    if (expectJson && response.json === undefined) {
      throw new ZenTaoError(CODES.UNSUPPORTED, `${what}的响应不是 JSON（拿不到可解析的数据）。`, {
        facts: { url: response.url, contentType: response.contentType, status: response.status },
        hint: '可能是该地址不是禅道的 REST 端点，或响应被代理/网关改写。用 /zentao doctor 看探测事实。',
      })
    }

    return response
  }

  function scopeError (spec) {
    return new ZenTaoError(
      CODES.VALIDATION,
      `查询「${spec.label}」必须指定范围：scope 需要 ${spec.scope.join(' 或 ')} 之一。`,
      { hint: '例如 scope: { product: "1" }；具体范围可先用 zentao_query 查 product/project。' },
    )
  }

  /**
   * 用 `/zentao switch` 设过的会话上下文补全省略的 scope。
   * 显式传入的 scope 永远优先；会话上下文只填空。
   */
  function withSessionScope (scopeInput) {
    const base = {}
    try {
      const session = getSessionContext?.()
      if (session?.productId) base.product = String(session.productId)
      if (session?.executionId) base.execution = String(session.executionId)
    } catch {
      // 上下文不可得就不补，交给调用方显式指定
    }
    return { ...base, ...(scopeInput ?? {}) }
  }

  function resolveScope (entity, scopeInput) {
    const spec = entityOf(entity)
    if (spec.enterprise && !resolveEnterpriseAllowed(entity)) {
      throw new ZenTaoError(
        CODES.UNSUPPORTED,
        `「${spec.label}」是禅道企业版功能，当前探测到的能力里没有它。`,
      )
    }
    const scope = {}
    for (const key of ['product', 'project', 'execution']) {
      const value = scopeInput?.[key]
      if (value !== undefined && value !== null && value !== '') scope[key] = String(value)
    }
    if (spec.scope.length === 0) return scope
    const provided = spec.scope.filter((key) => scope[key] !== undefined)
    if (provided.length === 0) throw scopeError(spec)
    // 只保留该实体接受的键，避免把 product 误传给需要 execution 的端点
    const trimmed = {}
    for (const key of provided) trimmed[key] = scope[key]
    return trimmed
  }

  function resolveEnterpriseAllowed (entity) {
    return ENTERPRISE_ENTITY_KEYS.includes(entity)
  }

  /* ─────────────── 读 ─────────────── */

  async function fetchListPage ({ dialect, entity, scope, page, limit, token, signal }) {
    const spec = dialect.listSpec(entity, { scope, page, limit })
    const response = await call({ dialect, spec, token, what: `查询${entityOf(entity).label}列表`, signal })
    const spec2 = entityOf(entity)
    // parsePage 目前是直通；保留这一层以便将来按方言调整信封
    const parsed = dialect.parsePage(entity, response.json)
    const raw = pickArray(parsed.json ?? response.json, spec2.plural)
    // 实际取到数组的那个键名（用于校准：服务端可能用 data 而不是 tasks）
    const envelope = parsed.json ?? response.json
    const usedKey = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
      ? (Array.isArray(envelope[spec2.plural])
          ? spec2.plural
          : Object.keys(envelope).find((key) => Array.isArray(envelope[key])))
      : undefined
    const config = getConfig()
    const items = raw.map((one) => normalizeItem(entity, one, {
      webLink: (e, id) => webLinkFor(dialect, config, e, id),
      excerptMode: config.stripRichText,
    }))
    // includeRawPayload 打开时，给**首条**附上脱敏后的原始载荷（用于校准字段名）。
    // 只给首条：整页都带会把工具结果撑爆。
    if (config.includeRawPayload && items.length > 0) {
      items[0].raw = redact(raw[0])
    }
    const meta = pickPageMeta(response.json, { page, limit })

    // **自诊断**：服务端说 total > 0，但我们声明的集合键下一个数组都没找到 ——
    // 说明响应信封与本插件假设的形状不符（企业版不同小版本可能不一样）。
    // 这种情况必须报错并把**实际的信封键名**带出来：否则用户得到的是一句
    // "0 条结果"这种静默的错误答案，而查起来极其困难。
    // 只在第一页判断：翻到超出末尾的页时 total > 0 且 0 条本来就是正常的。
    if (page === 1 && raw.length === 0 && Number(meta?.total ?? 0) > 0) {
      const envelopeKeys = response.json !== null && typeof response.json === 'object' && !Array.isArray(response.json)
        ? Object.keys(response.json).slice(0, 12)
        : []
      throw new ZenTaoError(
        CODES.UNSUPPORTED,
        `列表响应形状不认识：服务端报告 total=${meta.total}，但声明的集合键「${spec2.plural}」下没有数组。`,
        {
          facts: { expectedKey: spec2.plural, envelopeKeys, url: response.url },
          hint: '请把这条错误连同 /zentao sweep 的输出一起反馈，以便补上该信封形状；' +
            '在此之前，带过滤条件的查询不可信（服务端总数与本地可见条数不一致）。',
        },
      )
    }

    return { items, meta, rawCount: raw.length, usedKey }
  }

  /**
   * 多页扫描 + 本地过滤。
   * 因为在服务端过滤参数未实测前，过滤一律在本地做（见 domain/query.js 顶部说明），
   * 所以必须扫到"够了"或"到边界"为止，并在触边界时如实报 partial。
   */
  async function scanAndFilter ({ entity, scope, filters, orderBy, needed, signal }) {
    const dialect = await resolveDialect()
    const token = await authHeaders()
    const config = getConfig()
    const pageSize = Math.max(1, Math.min(config.maxPageSize ?? 50, 100))
    const collected = []
    let scanned = 0
    let total
    let page = 1
    let partial = false
    let partialNote
    let envelopeKey
    let effectiveLimit = pageSize

    for (; page <= SCAN_BOUNDS.maxPagesPerList; page += 1) {
      const { items, meta, rawCount, usedKey } = await fetchListPage({
        dialect, entity, scope, page, limit: pageSize, token, signal,
      })
      if (envelopeKey === undefined && usedKey !== undefined) envelopeKey = usedKey
      if (meta.limit !== undefined) effectiveLimit = meta.limit
      if (meta.total !== undefined) total = meta.total
      scanned += rawCount
      collected.push(...items)

      const matched = filterItems(collected, filters, todayIso())
      if (needed !== undefined && matched.length >= needed) break
      // 服务端没有更多：本页不足一页，或累计已达 total
      if (rawCount === 0 || rawCount < effectiveLimit) break
      if (total !== undefined && scanned >= total) break
      if (page === SCAN_BOUNDS.maxPagesPerList) {
        partial = true
        partialNote = `已扫描 ${scanned} 条（${SCAN_BOUNDS.maxPagesPerList} 页上限）仍未扫完`
      }
    }

    const matched = filterItems(collected, filters, todayIso())
    const sorted = sortItems(matched, orderBy)
    return { items: sorted, scanned, total, partial, partialNote, envelopeKey, dialect, config }
  }

  async function query ({ entity, scope, filters, orderBy, page = 1, pageSize, fields, signal }) {
    const spec = entityOf(entity)
    const resolvedScope = resolveScope(entity, withSessionScope(scope))
    let normalizedFilters
    let normalizedOrder
    try {
      normalizedFilters = normalizeFilters(filters)
      normalizedOrder = normalizeOrderBy(orderBy)
    } catch (error) {
      throw new ZenTaoError(CODES.VALIDATION, error.message)
    }
    const config = getConfig()
    const effectivePageSize = Math.max(1, Math.min(
      pageSize ?? config.maxResultItems ?? 20,
      config.maxPageSize ?? 50,
    ))
    const scan = await scanAndFilter({
      entity,
      scope: resolvedScope,
      filters: normalizedFilters,
      orderBy: normalizedOrder,
      needed: page * effectivePageSize,
      signal,
    })
    const paged = paginateLocally(scan.items, page, effectivePageSize)
    const projected = applyProjection(paged.items, fields)
    // 容错读取留下的**校准信号**：集合键与预期不同（例如服务端用 data 而非 tasks）。
    // 不影响本次结果（pickArray 已按容错取到），但值得让用户看见并反馈。
    const shapeNote = scan.envelopeKey !== undefined && scan.envelopeKey !== spec.plural
      ? `响应里的集合键是「${scan.envelopeKey}」而不是预期的「${spec.plural}」——已按容错读取，` +
        '但请把这条信息反馈给插件维护者以便校准。'
      : undefined
    return {
      entity,
      entityLabel: spec.label,
      items: projected,
      matchedTotal: paged.totalMatched,
      serverTotal: scan.total,
      scanned: scan.scanned,
      page,
      pageSize: effectivePageSize,
      hasMore: paged.hasMore,
      partial: scan.partial,
      partialNote: scan.partialNote,
      envelopeKey: scan.envelopeKey,
      shapeNote,
      siteLabel: config.label,
    }
  }

  /** 读单条摘要（写操作前的读、回读、缓存填充共用）。 */
  async function readCurrent ({ entity, id, signal, bypassCache = false }) {
    const config = getConfig()
    const ttl = (config.cacheTtlSeconds ?? 300) * 1000
    if (!bypassCache && ttl > 0) {
      const cached = await store.getEntity(entity, id)
      if (cached && nowMs() - cached.at < ttl) return cached.item
    }
    const dialect = await resolveDialect()
    const token = await authHeaders()
    const spec = dialect.detailSpec(entity, id)
    const response = await call({ dialect, spec, token, what: `读取${entityOf(entity).label} #${id}`, signal })
    const raw = dialect.parseItem(entity, response.json)

    // 详情响应必须含 `id` —— 整个模型（item.ref.id）都依赖它。没有 `id` 只有两种可能，
    // 而**两种都不能当成"查到了"**（否则会把一堆 undefined 渲染成一条成功的结果）：
    //   · 响应是空（null / {}）：禅道对不存在的编号可能返回 200 + 空 —— 该报 NOT_FOUND
    //   · 响应是有内容的对象但没有 id：形状与假设不符 —— 该报 UNSUPPORTED 并带出键名
    // 这正是前几轮那类"静默的错误答案"，只是换到了详情路径上。
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw) || raw.id === undefined) {
      const isEmpty = raw === null || raw === undefined ||
        (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)
      const envelopeKeys = response.json !== null && typeof response.json === 'object' && !Array.isArray(response.json)
        ? Object.keys(response.json).slice(0, 12)
        : []
      if (isEmpty) {
        throw new ZenTaoError(
          CODES.NOT_FOUND,
          `禅道没有返回${entityOf(entity).label} #${id} 的内容（编号可能不存在，或该账号无权查看）。`,
          { status: response.status, facts: { entity, id, url: response.url } },
        )
      }
      throw new ZenTaoError(
        CODES.UNSUPPORTED,
        `${entityOf(entity).label} #${id} 的响应形状不认识：拿到的对象里没有 id 字段。`,
        {
          facts: { entity, id, envelopeKeys, url: response.url },
          hint: '请把这条错误连同 /zentao sweep 的输出一起反馈，以便补上该详情形状。',
        },
      )
    }

    const item = normalizeItem(entity, raw, {
      webLink: (e, i) => webLinkFor(dialect, config, e, i),
      excerptMode: config.stripRichText,
    })
    if (config.includeRawPayload) item.raw = redact(raw)
    await store.setEntity(entity, id, { at: nowMs(), item })
    return item
  }

  async function get ({ entity, id, expand = [], signal }) {
    const spec = entityOf(entity)
    if (id === undefined || id === null || id === '') {
      throw new ZenTaoError(CODES.VALIDATION, '查询详情需要 id。')
    }
    const item = await readCurrent({ entity, id: String(id), signal })
    const notes = []
    const requested = new Set(Array.isArray(expand) ? expand : [])
    if (requested.has('comments') || requested.has('history') || requested.has('attachments')) {
      notes.push(
        `expand 里请求了 ${[...requested].join('、')}，但禅道 v1 的评论/历史/附件端点尚未实测校准，` +
        '本次未返回这些内容（不是空，是没做）。',
      )
    }
    return { entity, entityLabel: spec.label, item, notes }
  }

  /** 解析"我是谁"。my 的第一步，单独缓存。 */
  async function currentUser ({ signal } = {}) {
    const config = getConfig()
    const ttl = (config.cacheTtlSeconds ?? 300) * 1000
    const cached = await store.getEntity('user', 'me')
    if (cached && ttl > 0 && nowMs() - cached.at < ttl) return cached.item
    const dialect = await resolveDialect()
    const token = await authHeaders()
    const response = await call({ dialect, spec: dialect.meSpec(), token, what: '读取当前用户', signal })
    const raw = dialect.parseItem('user', response.json)
    const item = normalizeItem('user', raw, { excerptMode: 'strip' })
    // 权威身份标识：只用禅道真的给了的字段，**不要**用 title ——
    // title 在 realname 缺失时会退化成 `#<id>` 这种展示用字符串。
    const me = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    item.identity = {
      id: me.id === undefined || me.id === null ? undefined : String(me.id),
      account: typeof me.account === 'string' && me.account.trim() !== '' ? me.account.trim() : undefined,
      realname: typeof me.realname === 'string' && me.realname.trim() !== '' ? me.realname.trim() : undefined,
    }
    await store.setEntity('user', 'me', { at: nowMs(), item })
    return item
  }

  /**
   * 「我的」聚合。
   * 禅道 v1 **没有**聚合端点（已核验），所以只能：
   *   解析当前用户 → 找可见范围（项目/执行、产品）→ 逐范围取列表 → 本地按指派人过滤。
   * 请求数是 O(项目×执行)，因此每一项都有**硬上限**，触上限就报 PARTIAL 并说明扫描范围。
   */
  async function my ({ scope = 'assigned', include, dueWithin, signal }) {
    const config = getConfig()
    const me = await currentUser({ signal })

    // 身份标识用**精确**匹配的候选集（account / realname / title / id），
    // 并且**拒绝**在没有可靠标识时硬着头皮去匹配 —— 那只会得到一份静默的"0 条"。
    const rawNeedles = [me.identity?.account, me.identity?.realname, me.title, me.identity?.id]
    const needles = [...new Set(rawNeedles
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      // 排除展示用的占位符：`#<id>` 与「（无标题）」都不是任何真实用户标识。
      // 留着它们只会让匹配静默失败，得到一份"0 条"的假象。
      .filter((value) => value !== '' && !/^#\d+$/.test(value) && value !== PLACEHOLDER_TITLE))]
    if (needles.length === 0) {
      throw new ZenTaoError(
        CODES.AMBIGUOUS,
        '无法从禅道读取当前用户的可识别身份（账号/姓名/编号都拿不到），`zentao_my` 需要它来匹配指派人。',
        { hint: '请确认该 Token 对应的账号能访问 /user 端点；也可以先用 zentao_query(entity="task", filters={assignee:"..."}) 手动查询。' },
      )
    }
    const displayName = me.identity?.realname ?? me.identity?.account ?? me.title
    const identity = needles
    const wanted = Array.isArray(include) && include.length > 0 ? include : ['task', 'bug']
    const filters = { assignee: needles }
    if (scope === 'opened') {
      delete filters.assignee
      filters.openedBy = needles
    }
    if (dueWithin === 'today') filters.dueBefore = todayIso()
    if (dueWithin === 'overdue') filters.overdue = true
    if (typeof dueWithin === 'string' && /^\d+d$/.test(dueWithin)) {
      const days = Number(dueWithin.slice(0, -1))
      const limit = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
      filters.dueBefore = limit
    }

    const groups = []
    const notes = []

    if (wanted.includes('task') || wanted.includes('todo')) {
      const executions = await visibleExecutions({ signal })
      if (executions.items.length === 0) {
        groups.push({ entity: 'task', items: [], scanned: 0, partial: executions.partial, note: '没有可见的执行' })
      } else {
        const collected = []
        let scanned = 0
        for (const execution of executions.items) {
          const scan = await scanAndFilter({
            entity: 'task',
            scope: { execution: execution.ref.id },
            filters,
            orderBy: 'updated_desc',
            needed: config.maxResultItems ?? 20,
            signal,
          })
          collected.push(...scan.items)
          scanned += scan.scanned
        }
        groups.push({
          entity: 'task',
          items: sortItems(collected, 'due_asc'),
          scanned,
          partial: executions.partial,
          note: `已扫描 ${executions.items.length} 个执行${executions.partial ? `（共 ${executions.total ?? '未知'} 个，达上限）` : ''}`,
        })
      }
    }

    if (wanted.includes('bug')) {
      const products = await visibleProducts({ signal })
      const collected = []
      let scanned = 0
      for (const product of products.items) {
        const scan = await scanAndFilter({
          entity: 'bug',
          scope: { product: product.ref.id },
          filters,
          orderBy: 'updated_desc',
          needed: config.maxResultItems ?? 20,
          signal,
        })
        collected.push(...scan.items)
        scanned += scan.scanned
      }
      groups.push({
        entity: 'bug',
        items: sortItems(collected, 'due_asc'),
        scanned,
        partial: products.partial,
        note: `已扫描 ${products.items.length} 个产品${products.partial ? `（共 ${products.total ?? '未知'} 个，达上限）` : ''}`,
      })
    }

    if (wanted.includes('story') || wanted.includes('effort')) {
      notes.push(`include 里的 ${wanted.filter((w) => ['story', 'effort'].includes(w)).join('、')} 尚未实现（v1 无"我的需求/工时"端点），本次未返回。`)
    }

    const partial = groups.some((group) => group.partial)
    return {
      // 展示名与**实际用于匹配的标识**都给出来：万一日志里看到"某人看到别人的待办"，
      // 这一段就能直接说明是按什么匹配的。
      user: displayName,
      matchedBy: needles,
      scope,
      groups,
      partial,
      siteLabel: config.label,
      notes: [
        ...notes,
        `${scope === 'opened' ? '创建人' : '指派人'}按精确标识匹配：${needles.join(' / ')}`,
        ...groups.map((group) => `${entityOf(group.entity).label}：${group.note}`),
      ],
    }
  }

  /**
   * 可见执行列表（`my` 用；有硬上限）。
   * 结果按 `cacheTtlSeconds` 缓存 —— 否则每次 `zentao_my` 都要把项目树重走一遍。
   */
  async function visibleExecutions ({ signal, bypassCache = false }) {
    const config = getConfig()
    const ttl = (config.cacheTtlSeconds ?? 300) * 1000
    if (!bypassCache && ttl > 0) {
      const cached = await store.getEntity('scope', 'executions')
      if (cached && nowMs() - cached.at < ttl) return cached.item
    }
    const dialect = await resolveDialect()
    const token = await authHeaders()
    const projects = await fetchListPage({
      dialect, entity: 'project', scope: {}, page: 1, limit: config.maxPageSize, token, signal,
    })
    const limited = projects.items.slice(0, SCAN_BOUNDS.myMaxProjects)
    const items = []
    let partial = projects.items.length > limited.length
    for (const project of limited) {
      const executions = await fetchListPage({
        dialect, entity: 'execution', scope: { project: project.ref.id }, page: 1, limit: config.maxPageSize, token, signal,
      })
      if (executions.items.length > SCAN_BOUNDS.myMaxExecutionsPerProject) partial = true
      items.push(...executions.items.slice(0, SCAN_BOUNDS.myMaxExecutionsPerProject))
    }
    const result = { items, partial, total: projects.meta.total }
    if (ttl > 0) await store.setEntity('scope', 'executions', { at: nowMs(), item: result })
    return result
  }

  /** 可见产品列表（`my` 用；有硬上限）。同样进缓存。 */
  async function visibleProducts ({ signal, bypassCache = false }) {
    const config = getConfig()
    const ttl = (config.cacheTtlSeconds ?? 300) * 1000
    if (!bypassCache && ttl > 0) {
      const cached = await store.getEntity('scope', 'products')
      if (cached && nowMs() - cached.at < ttl) return cached.item
    }
    const dialect = await resolveDialect()
    const token = await authHeaders()
    const page = await fetchListPage({
      dialect, entity: 'product', scope: {}, page: 1, limit: config.maxPageSize, token, signal,
    })
    const limited = page.items.slice(0, SCAN_BOUNDS.myMaxProducts)
    const result = { items: limited, partial: page.items.length > limited.length, total: page.meta.total }
    if (ttl > 0) await store.setEntity('scope', 'products', { at: nowMs(), item: result })
    return result
  }

  /**
   * 看板：一次拿到范围的分组计数 + 阻塞项 + 高优先级项。
   *
   * 各范围能取到什么（这是端点形态决定的，不是选择）：
   *   · execution：需求（挂执行）+ 任务（挂执行）+ Bug（经该执行的产品）
   *   · project  ：需求（挂项目）+ 执行（挂项目）+ 任务（分散在各执行里 → **有界跨执行扫描**）
   *   · product  ：需求 + Bug（任务/执行都不在产品范围下）
   * 取不到的组合会写进 notes 说明原因，而不是悄悄少给一组。
   */
  async function board ({ scope, id, include, signal }) {
    const config = getConfig()
    // 默认分组**按范围区分**：项目范围里"执行"是核心上下文（项目就由执行组成），
    // 而 Bug 在项目范围下取不到（挂产品），所以默认不要它、也不产生无谓的说明。
    const defaultKeys = scope === 'project'
      ? ['stories', 'executions', 'tasks']
      : ['stories', 'tasks', 'bugs']
    const wanted = Array.isArray(include) && include.length > 0 ? include : defaultKeys
    const scopeLabel = `${scope} #${id}`
    const counts = []
    const all = []
    const notes = []
    const target = String(id)

    /**
     * 记一组计数。
     *
     * `serverTotal` 是服务端报告的总数，**优先用它**：看板上的数字是给人看的"这个范围有多少"，
     * 而不是"我们这一页取回了多少"。曾经的实现用 `items.length`，于是在大范围下会把
     * 第一页的 50 当成总数显示 —— 那是个看起来很像真的的错数字。
     */
    const pushGroup = (entity, items, serverTotal) => {
      const byStatus = new Map()
      for (const item of items) {
        const status = item.statusLabel ?? '（无状态）'
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
      }
      const counted = Number.isFinite(serverTotal) ? serverTotal : items.length
      counts.push({
        label: entityOf(entity).label,
        total: counted,
        // 状态分布只覆盖取回的那批，若两者不一致必须说清楚，不能让分布看起来像全量
        byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
        byStatusBasis: items.length,
      })
      all.push(...items)
    }

    const collect = async (entity, scopeObj, key) => {
      if (!wanted.includes(key)) return []
      const result = await query({ entity, scope: scopeObj, page: 1, pageSize: config.maxPageSize, signal })
      pushGroup(entity, result.items, result.serverTotal)
      if (result.partial) notes.push(`${entityOf(entity).label}：${result.partialNote}`)
      if (Number.isFinite(result.serverTotal) && result.serverTotal > result.items.length) {
        notes.push(`${entityOf(entity).label}：共 ${result.serverTotal} 条，本次取回 ${result.items.length} 条用于统计状态分布。`)
      }
      return result.items
    }

    /** 项目下的任务分散在各执行里：每个执行只取 1 页，并如实说明覆盖范围。 */
    const collectTasksAcrossExecutions = async (projectId) => {
      if (!wanted.includes('tasks')) return
      const executions = await query({
        entity: 'execution', scope: { project: projectId }, page: 1, pageSize: config.maxPageSize, signal,
      })
      const limited = executions.items.slice(0, SCAN_BOUNDS.boardExecutionsForTasks)
      const dialect = await resolveDialect()
      const token = await authHeaders()
      const collected = []
      let taskTotal = 0
      let totalKnown = false
      for (const execution of limited) {
        const page = await fetchListPage({
          dialect, entity: 'task', scope: { execution: execution.ref.id }, page: 1, limit: config.maxPageSize, token, signal,
        })
        collected.push(...page.items)
        // 每个执行只取 1 页，所以用**服务端报告的总数**累加，而不是取到的条数
        if (Number.isFinite(page.meta?.total)) {
          taskTotal += page.meta.total
          totalKnown = true
        } else {
          taskTotal += page.items.length
        }
      }
      pushGroup('task', collected, totalKnown ? taskTotal : undefined)
      if (limited.length < executions.matchedTotal) {
        notes.push(`任务只覆盖了前 ${limited.length}/${executions.matchedTotal} 个执行（避免请求数爆炸），` +
          '因此任务计数**不完整**；要看某个执行的完整任务请用 execution 范围。')
      }
      if (limited.length === 0) {
        notes.push('该项目下没有执行，因此没有可统计的任务。')
      }
    }

    if (scope === 'execution') {
      await collect('story', { execution: target }, 'stories')
      await collect('task', { execution: target }, 'tasks')
      if (wanted.includes('bugs')) {
        // Bug 挂产品不挂执行：先查执行拿到它的 product
        try {
          const execution = await readCurrent({ entity: 'execution', id: target, signal })
          if (execution.product?.id) {
            await collect('bug', { product: execution.product.id }, 'bugs')
          } else {
            notes.push('该执行没有关联产品，无法取它的 Bug。')
          }
        } catch (error) {
          if (!(error instanceof ZenTaoError) || error.code !== CODES.NOT_FOUND) throw error
          notes.push('读取执行详情失败（404），未取 Bug。')
        }
      }
      if (wanted.includes('executions')) notes.push('范围本身就是执行，已忽略 include 里的 executions。')
    } else if (scope === 'project') {
      await collect('story', { project: target }, 'stories')
      await collect('execution', { project: target }, 'executions')
      await collectTasksAcrossExecutions(target)
      if (wanted.includes('bugs')) {
        notes.push('Bug 挂在产品下、不在项目范围里：请用产品范围看板，或 zentao_query(entity="bug", scope={product})。')
      }
    } else if (scope === 'product') {
      await collect('story', { product: target }, 'stories')
      await collect('bug', { product: target }, 'bugs')
      if (wanted.includes('tasks') || wanted.includes('executions')) {
        notes.push('任务与执行挂在项目/执行下，不在产品范围内；请用项目或执行范围。')
      }
    } else {
      throw new ZenTaoError(CODES.VALIDATION, `看板的 scope 只支持 execution / project / product，收到 "${scope}"。`)
    }

    const today = todayIso()
    const blockers = all.filter((item) => {
      if (!item.dueDate) return false
      if (String(item.dueDate) >= today) return false
      return !['done', 'closed', 'resolved', 'cancel'].includes(item.statusCode)
    })
    const topItems = all.filter((item) => item.priority !== undefined && item.priority <= 2)
    return {
      scopeLabel,
      counts,
      blockers: sortItems(blockers, 'due_asc'),
      topItems: sortItems(topItems, 'priority_asc'),
      notes,
      note: notes.length > 0 ? notes.join('\n') : undefined,
    }
  }

  /* ─────────────── 写 ─────────────── */

  function validateWriteInput ({ action, entity, id, payload, reason, bulk, scope }) {
    const actionSpec = writeActionOf(action)
    const entitySpec = entityOf(entity)
    if (!actionSpec.entities.includes(entity)) {
      throw new ZenTaoError(
        CODES.VALIDATION,
        `写操作「${actionSpec.label}」不支持实体「${entitySpec.label}」。` +
        `支持：${actionSpec.entities.map((key) => ENTITIES[key].label).join('、')}。`,
      )
    }
    // 批量调用时，id 与 payload 都由**每个条目**提供，顶层不必给。
    const hasBulk = Array.isArray(bulk) && bulk.length > 0
    if (actionSpec.requiresId && !hasBulk && (id === undefined || id === null || id === '')) {
      throw new ZenTaoError(CODES.VALIDATION, `写操作「${actionSpec.label}」必须提供 id。`)
    }
    if (actionSpec.payloadRequired && !hasBulk
      && (payload === undefined || payload === null || Object.keys(payload).length === 0)) {
      throw new ZenTaoError(CODES.VALIDATION, `写操作「${actionSpec.label}」必须提供 payload。`)
    }
    if (actionSpec.reasonRequired && (reason === undefined || String(reason).trim() === '')) {
      throw new ZenTaoError(
        CODES.VALIDATION,
        `写操作「${actionSpec.label}」必须提供 reason（会作为备注写入禅道，避免无声变更）。`,
      )
    }
    // 批量总闸先于字段校验：未开启时应该直接告诉用户"功能没开"，而不是先报字段错
    if (bulk !== undefined) {
      if (!Array.isArray(bulk)) throw new ZenTaoError(CODES.VALIDATION, 'bulk 必须是数组。')
      const config = getConfig()
      if (!config.allowBulkWrite) {
        throw new ZenTaoError(
          CODES.VALIDATION,
          '批量写当前被禁用（allowBulkWrite=false）。请让用户在设置页开启，或改为逐条调用。',
        )
      }
      if (bulk.length > (config.maxBulkItems ?? 20)) {
        throw new ZenTaoError(CODES.VALIDATION, `批量条数 ${bulk.length} 超过上限 ${config.maxBulkItems}。`)
      }
      for (const entry of bulk) {
        if (entry === null || typeof entry !== 'object') {
          throw new ZenTaoError(CODES.VALIDATION, 'bulk 的每一项都必须是 { id, payload } 形状的对象。')
        }
        if (entry.id === undefined || entry.id === null || entry.id === '') {
          throw new ZenTaoError(CODES.VALIDATION, 'bulk 的每一项都必须提供 id。')
        }
      }
    }

    // 字段级校验：只接受**手册已文档化**的字段（按实体）。
    // 拒绝而不是静默丢弃 —— 静默丢弃会让模型以为字段改生效了。
    if (action === 'update' && !hasBulk) {
      const patch = payload?.patch ?? payload ?? {}
      const allowed = WRITE_UPDATE_FIELDS[entity] ?? []
      const illegal = Object.keys(patch).filter((key) => !allowed.includes(key))
      if (illegal.length > 0) {
        throw new ZenTaoError(
          CODES.VALIDATION,
          `修改「${entitySpec.label}」不接受这些字段：${illegal.join('、')}。`,
          {
            hint: `「${entitySpec.label}」允许修改的字段：${allowed.join('、')}。` +
              (entity === 'task' || entity === 'bug'
                ? '注意：改状态请用 start/finish（任务）或 resolve/close（Bug），这两个实体没有 status 字段可改。'
                : ''),
          },
        )
      }
    }
    if (action === 'create') {
      const allowed = WRITE_CREATE_FIELDS[entity] ?? []
      const scopeCarriers = ['execution', 'product']
      const illegal = Object.keys(payload ?? {})
        .filter((key) => !allowed.includes(key) && !scopeCarriers.includes(key))
      if (illegal.length > 0) {
        throw new ZenTaoError(
          CODES.VALIDATION,
          `新建「${entitySpec.label}」不接受这些字段：${illegal.join('、')}。`,
          { hint: `允许的字段：${allowed.join('、')}。` },
        )
      }
      if (entity === 'task' && !(payload?.execution ?? scope?.execution)) {
        throw new ZenTaoError(
          CODES.VALIDATION,
          '新建任务必须给出所属执行：在 payload 里填 execution，或用 scope.execution 指定。',
          { hint: '执行 id 可先用 zentao_query(entity="execution", scope={project:"<项目id>"}) 查到。' },
        )
      }
      if (entity === 'bug' && !(payload?.product ?? scope?.product)) {
        throw new ZenTaoError(
          CODES.VALIDATION,
          '新建 Bug 必须给出所属产品：在 payload 里填 product，或用 scope.product 指定。',
          { hint: '产品 id 可先用 zentao_query(entity="product") 查到。' },
        )
      }
    }
    // 批量总闸与逐条 id 校验已在上方完成（先于字段校验）
    return actionSpec
  }

  /** 可校验字段的对照：只有这几项能可靠地做写后比对（字段名映射明确）。 */
  const VERIFIABLE = Object.freeze({
    status: (item) => item.statusCode,
    assignedTo: (item) => item.assignee?.name,
    assignee: (item) => item.assignee?.name,
    pri: (item) => item.priority,
    priority: (item) => item.priority,
    title: (item) => item.title,
    name: (item) => item.title,
    resolution: (item) => item.extra?.resolution,
  })

  function verifyAgainst (payload, item) {
    const patch = payload?.patch ?? payload ?? {}
    const diff = []
    for (const [key, expected] of Object.entries(patch)) {
      const read = VERIFIABLE[key]
      if (!read) continue
      const actual = read(item)
      const normalize = (value) => (value === undefined || value === null ? '' : String(value).toLowerCase())
      if (normalize(actual) !== normalize(expected)) {
        diff.push(`${key} 期望 ${expected} 实际 ${actual ?? '（未返回）'}`)
      }
    }
    return diff
  }

  function extractCreatedId (json, entity) {
    if (json === null || typeof json !== 'object') return undefined
    const direct = toId(json.id)
    if (direct !== undefined) return direct
    const plural = entityOf(entity).plural
    for (const key of [plural, entity, 'data', 'item']) {
      const value = json[key]
      if (value && typeof value === 'object') {
        const id = toId(Array.isArray(value) ? value[0]?.id : value.id)
        if (id !== undefined) return id
      }
    }
    return undefined
  }

  async function writeOne ({ action, entity, id, payload, reason, expectedVersion, dryRun, signal, scope }) {
    const dialect = await resolveDialect()
    const config = getConfig()
    const entityLabel = entityOf(entity).label
    const enrichedPayload = reason && (action === 'close' || action === 'resolve')
      ? { ...payload, reason }
      : payload

    // 区分两类错误（这个区分决定了调用方看到的是"报错"还是"条目失败"）：
    //   · 组装请求就失败（缺必填字段、不支持的实体） = **调用方错误** → 打标记后抛出
    //   · 请求发出后失败（权限、冲突、网络）        = 环境问题 → 逐条汇报，不中断批量
    let spec
    try {
      spec = dialect.writeSpec(action, { entity, id, payload: enrichedPayload, scope })
    } catch (error) {
      if (error instanceof ZenTaoError) error.zentaoCallerError = true
      throw error
    }

    // 未校准的写形状默认闸门（安全默认）：
    // comment / resolve / close / log_effort 等动作，官方手册**没有给出 REST 形状**，
    // 我们只能按同类端点外推。盲目发送有打到别的端点、改动非预期数据的风险，
    // 因此默认只允许 dryRun；确认真实行为后由用户显式打开 allowUnverifiedWrites。
    if (!dryRun && spec.verified === false && !config.allowUnverifiedWrites) {
      const error = new ZenTaoError(
        CODES.UNSUPPORTED,
        `写操作「${writeActionOf(action).label}」的请求形状尚未经真机校准` +
        '（官方手册没有给出该动作的 REST 形状），为避免误写已默认阻止。',
        {
          facts: { action, entity, method: spec.method, path: spec.path, reason: spec.note },
          hint: '先用 dryRun=true 查看将要发出的请求；用 /zentao sweep 在真实环境核实后，' +
            '再到设置页打开 allowUnverifiedWrites 才会真正执行。',
        },
      )
      error.zentaoCallerError = true
      throw error
    }

    if (dryRun) {
      return {
        dryRun: true,
        method: spec.method,
        // 计划里给**实际请求路径**（含 API 前缀），用户核对时可以直接照着试
        path: `${dialect.basePath ?? ''}${spec.path}`,
        body: spec.body === undefined ? undefined : redact(spec.body),
        id,
        verified: spec.verified,
        note: spec.note,
      }
    }

    const token = await authHeaders()
    const key = objectKey(entity, id ?? `new-${fnv1a(stableStringify(enrichedPayload))}`)

    return locks.run(key, async () => {
      // ① 幂等：同参数写操作在窗口内不重复落库
      const idemKey = idempotencyKey(action, entity, id, enrichedPayload)
      const existing = await store.getIdempotency(idemKey)
      if (existing && nowMs() - existing.at < IDEMPOTENCY_TTL_MS) {
        // 用**上次写成功时记下的 resultRef**：create 的入参里没有 id，
        // 若只回传入参 id，重复创建会返回 id=undefined —— 调用方拿不到它"已创建"的记录引用。
        const knownId = existing.resultRef ?? id
        const current = knownId ? await readCurrent({ entity, id: String(knownId), signal, bypassCache: true }) : undefined
        return {
          ok: true,
          idempotent: true,
          id: knownId,
          title: current?.title,
          url: current?.url,
          diff: [],
        }
      }

      // ② 乐观并发校验：调用方若带上此前读到的基线，先比对当前值。
      //
      // 基线有两种形态（实测决定）：
      //   · **version**（数字/数字串）：服务端明细里的 version 字段。注意本机 IPD 5.6 实测
      //     **PUT 不递增 version**（连着两次更新后 version 一直是 "1"），所以只靠它检测不到冲突；
      //   · **updatedAt / lastEditedDate**（ISO 时间串）：实测**每次更新都会变**，
      //     是这台服务器上真正可用的并发令牌。因此也接受时间戳形式。
      let current
      let baselineIsTimestamp = false
      if (id) {
        current = await readCurrent({ entity, id: String(id), signal, bypassCache: true })
        if (expectedVersion !== undefined && expectedVersion !== null) {
          const expected = String(expectedVersion)
          baselineIsTimestamp = /^\d{4}-\d{2}-\d{2}T/.test(expected)
          if (baselineIsTimestamp) {
            if (current.updatedAt !== undefined && String(current.updatedAt) !== expected) {
              throw new ZenTaoError(
                CODES.CONFLICT,
                `${entityLabel} #${id} 自你读取后已被修改（更新时间 ${expected} → ${current.updatedAt}），本次未写入。`,
                { facts: { entity, id, expected, actual: current.updatedAt, basis: 'updatedAt' } },
              )
            }
          } else if (current.version !== undefined) {
            const verdict = checkVersion(expectedVersion, current.version)
            if (!verdict.ok) {
              throw new ZenTaoError(
                CODES.CONFLICT,
                `${entityLabel} #${id} 已被他人修改（版本 ${verdict.expected} → ${verdict.actual}），本次未写入。`,
                { facts: { entity, id, expected: verdict.expected, actual: verdict.actual } },
              )
            }
          }
        }
      }

      // ③ 真正写入。
      // 只有数字形态的基线才作为 version 字段发给服务端 —— 时间戳是本地比对用的，
      // 发给禅道只会是一个它看不懂的未知字段。
      const body = spec.body === undefined
        ? undefined
        : {
            ...spec.body,
            ...(expectedVersion !== undefined && expectedVersion !== null && !baselineIsTimestamp
              ? { version: expectedVersion }
              : {}),
          }
      const writeResponse = await call({
        dialect,
        spec: { ...spec, body },
        token,
        what: `${writeActionOf(action).label}${entityLabel}${id ? ` #${id}` : ''}`,
        signal,
        // 写请求的成功响应可能是合法空体（如 DELETE 返回 200 无内容），不能要求 JSON
        expectJson: false,
      })

      // ④ 强制回读校验（"返回 200 就当成功"是这类集成最常见的坑）
      const newId = id ?? extractCreatedId(writeResponse.json, entity)
      if (newId === undefined && action === 'create') {
        return {
          ok: true,
          id: undefined,
          title: undefined,
          diff: [],
          verified: false,
          note: '创建请求已被接受，但响应里没有返回新对象 id，无法回读校验。',
        }
      }
      // 回读失败**绝不能**报成"写入失败" —— 写入请求已经被禅道接受了。
      // 真实状态未知，必须如实说"未确认"，让用户去禅网上复核。
      let readback
      let readbackError
      let hardDeleted = false
      if (newId !== undefined) {
        try {
          readback = await readCurrent({ entity, id: String(newId), signal, bypassCache: true })
        } catch (error) {
          const zerr = error instanceof ZenTaoError ? error : asZenTaoError(error)
          // **删除后的 404 是成功信号，不是回读失败。** 曾经的实现在这里把"对象已经没了"
          // 报成"回读校验失败"，恰好把成功说成未确认。
          if (action === 'delete' && zerr.code === CODES.NOT_FOUND) {
            hardDeleted = true
          } else {
            readbackError = zerr
          }
        }
      }
      if (readbackError) {
        await store.setIdempotency(idemKey, { at: nowMs(), resultRef: newId })
        return {
          ok: true,
          idempotent: false,
          id: newId ?? id,
          title: current?.title,
          diff: [],
          verified: false,
          readbackError: { code: readbackError.code, message: readbackError.message },
          note: `写入请求已被禅道接受，但**回读校验失败**：[${readbackError.code}] ${readbackError.message}`,
        }
      }

      // ④a 删除的校验必须验证**意图**（对象真的不可用了），而不是比对载荷字段 ——
      // 删除请求的载荷里没有任何可比对字段，于是原先无论删没删成都报"已验证"。
      // 实测：真实禅道是**软删除**（详情仍可读但 `deleted: true`，且不再出现在列表里）。
      if (action === 'delete') {
        const gone = hardDeleted || readback === undefined || readback.deleted === true
        await store.setIdempotency(idemKey, { at: nowMs(), resultRef: newId })
        return {
          ok: true,
          idempotent: false,
          id: newId ?? id,
          title: readback?.title ?? current?.title,
          url: readback?.url,
          diff: [],
          verified: gone,
          note: gone
            ? (hardDeleted || readback === undefined
              ? '已删除（回读为 404：对象已不可读）。'
              : '已删除（软删除：详情仍可读但标记为已删除，且不再出现在列表里）。')
            : '删除请求被禅道接受，但**回读显示对象仍然可读且未被标记删除** —— 删除可能没有生效，请到禅网上复核。',
        }
      }

      const diff = readback ? verifyAgainst(enrichedPayload, readback) : []

      // ④b 备注（comment）走的是"PUT 详情带 comment 字段"这条**推断**出来的形状。
      // 实测：真实禅道接受了这个 PUT，但**没有产生任何动作记录**（actions 里没有新的备注条）——
      // 也就是说"HTTP 成功"完全没有证明备注落库了。因此这里**不声称已验证**。
      if (action === 'comment') {
        await store.setIdempotency(idemKey, { at: nowMs(), resultRef: newId })
        return {
          ok: true,
          idempotent: false,
          id: newId ?? id,
          title: readback?.title ?? current?.title,
          url: readback?.url,
          diff: [],
          verified: false,
          note: '备注请求已被禅道接受，但**备注是否真的落库无法确认**（v1 没有独立备注端点，' +
            '实测"PUT 详情带 comment"不产生动作记录）—— 请到禅网上确认。给任务留言请改用 ' +
            'start/finish 的 comment 字段（那两个是[文档]确认的）。',
        }
      }

      await store.setIdempotency(idemKey, { at: nowMs(), resultRef: newId })
      await store.setEntity(entity, String(newId ?? id), { at: nowMs(), item: readback })

      return {
        ok: true,
        idempotent: false,
        id: newId ?? id,
        title: readback?.title ?? current?.title,
        url: readback?.url,
        diff,
        verified: readback !== undefined,
        note: readback === undefined ? '写入已完成，但未能回读校验。' : undefined,
      }
    })
  }

  async function write (input) {
    const { action, entity, payload = {}, reason, expectedVersion, dryRun = true, bulk, signal, scope: rawScope } = input
    const scope = withSessionScope(rawScope)
    const actionSpec = validateWriteInput(input)
    const items = Array.isArray(bulk) && bulk.length > 0
      ? bulk
      : [{ id: input.id, payload }]

    const results = []
    const steps = []
    for (const entry of items) {
      const rawEntry = entry ?? {}
      let effectivePayload = rawEntry.payload
      if (effectivePayload === undefined && rawEntry.patch !== undefined) effectivePayload = { patch: rawEntry.patch }
      if (effectivePayload === undefined) effectivePayload = payload
      const effective = {
        action,
        entity,
        id: rawEntry.id ?? input.id,
        payload: effectivePayload,
        reason: rawEntry.reason ?? reason,
        expectedVersion: rawEntry.expectedVersion ?? expectedVersion,
        dryRun,
        signal,
        scope: rawEntry.scope ?? scope,
      }
      try {
        const result = await writeOne(effective)
        if (dryRun) {
          steps.push(result)
        } else {
          results.push(result)
        }
      } catch (error) {
        const zerr = asZenTaoError(error)
        // 调用方错误（请求本身不合法）一律抛出，让模型看到结构化错误并改正调用；
        // 只有环境/服务端失败才作为"条目失败"逐条汇报。
        if (dryRun || zerr.zentaoCallerError) throw zerr
        results.push({
          ok: false,
          id: effective.id,
          errorCode: zerr.code,
          errorMessage: zerr.message,
          hint: zerr.hint,
        })
      }
    }

    if (dryRun) {
      const verified = steps.every((step) => step.verified !== false)
      return {
        dryRun: true,
        actionLabel: actionSpec.label,
        entityLabel: entityOf(entity).label,
        steps,
        verified,
        notes: steps.map((step) => step.note).filter(Boolean),
      }
    }

    return {
      actionLabel: actionSpec.label,
      results,
      idempotent: results.some((result) => result.idempotent === true),
      partial: results.some((result) => result.ok) && results.some((result) => !result.ok),
    }
  }

  /** 一次性用账号密码换取 Token（设置页便利路径；密码即用即弃）。 */
  async function exchangeToken ({ account, password, signal }) {
    if (!account || !password) {
      throw new ZenTaoError(CODES.VALIDATION, '换取 Token 需要 account 与 password。')
    }
    const dialect = await resolveDialect()
    const spec = dialect.tokenSpec(account, password)
    const response = await transport.request({
      base: apiBase(dialect, getConfig()),
      method: spec.method,
      path: spec.path,
      body: spec.body,
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
    if (!response.ok) {
      const error = dialect.parseError(response, { what: '换取 Token' })
      // 真实观测（禅道 IPD 集成运行环境）：账号或密码不对时 `POST /tokens` 返回
      // **400**，响应体是 `{"error":"登录失败，请检查您的用户名或密码是否填写正确。"}`，
      // 不是文档暗示的 401。这条 hint 直接说清，省去用户排查 Token 为什么"无效"。
      if (response.status === 400) {
        error.hint = '禅道在账号或密码不对时返回 400（实测确认，不是 401）。请核对账号与密码；' +
          '它们存在 DSH 凭据库里，可在设置页的"禅道"卡片修改。'
      }
      throw error
    }
    const token = response.json?.token
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ZenTaoError(
        CODES.VALIDATION,
        '禅道没有返回 token（账号或密码可能不正确，或该禅道未开启 API）。',
        { facts: { status: response.status } },
      )
    }
    return { token: token.trim() }
  }

  /** 诊断事实表（`/zentao doctor`）。 */
  async function doctor ({ signal } = {}) {
    const config = getConfig()
    const lines = ['禅道插件诊断', `站点名：${config.label ?? '（未设置）'}`, `baseURL：${config.baseURL ?? '（未设置）'}`]
    const facts = { config: redact(config) }
    // 认证现在是"账号 + 密码 → 换 Token"。诊断里如实分开报告：
    // 凭据是否齐备、以及**本次是否真的换到了 Token**（后者才说明账号密码可用）。
    const auth = typeof describeAuth === 'function' ? await describeAuth().catch(() => undefined) : undefined
    if (auth) {
      const mark = (info) => (info?.configured
        ? `已配置（来源：${info.source ?? (info.record ? `凭据记录 ${info.record}` : '凭据库')}${info.writable === false ? '，只读' : ''}）`
        : '未配置')
      lines.push(`账号：${mark(auth.account)}`)
      lines.push(`密码：${mark(auth.password)}`)
    }
    const token = await getToken().catch(() => undefined)
    facts.tokenConfigured = Boolean(token)
    lines.push(`换取 Token：${token ? '成功（仅内存缓存，不落盘）' : '未成功（缺凭据或账号密码不被接受）'}`)
    // 启动期注册失败：这类问题曾经"静默吞掉"，最后以**每一轮都报错**的形式暴露（真机事故）。
    // 现在它是一眼可见的一行。
    if (typeof getStartupFailures === 'function') {
      const failures = getStartupFailures()
      if (Array.isArray(failures) && failures.length > 0) {
        lines.push(`启动期注册失败：${failures.length} 项（这些能力当前不生效）`)
        for (const failure of failures) lines.push(`  · ${failure.area}：${failure.message}`)
      }
    }
    lines.push(`写入策略：${config.writePolicy}`)
    lines.push(`批量写：${config.allowBulkWrite ? `开启（上限 ${config.maxBulkItems}）` : '关闭'}`)
    lines.push(`TLS：证书校验始终开启（自签名内网请用 NODE_EXTRA_CA_CERTS 注入企业根证书）`)
    if (process?.env?.NODE_EXTRA_CA_CERTS) {
      lines.push(`  NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}`)
    } else {
      lines.push('  NODE_EXTRA_CA_CERTS 未设置')
    }

    if (!config.baseURL) {
      return { text: lines.join('\n'), facts, ok: false }
    }

    try {
      const result = await reprobe()
      facts.probe = result
      // 直接复用 probe.js 的渲染，而不是在这里再抄一遍 ——
      // 之前就是抄的，于是新增的"命中端点/被拒端点"字段没出现在 doctor 里。
      lines.push('', '探测结论：', ...describeProbe(result).split('\n').map((line) => `  ${line}`))
      const dialect = await resolveDialect()
      if (typeof dialect.listWriteShapeNotes === 'function') {
        const notes = dialect.listWriteShapeNotes()
        lines.push('', `写操作形状校准：${notes.length === 0 ? '已全部实测校准' : `${notes.length} 项尚未实测校准`}`)
        // 打印**实体列表**而不是 method —— 生产者返回的是 { action, entities, note }，
        // 打印不存在的字段只会得到 "start（undefined）"（真实缺陷，已修）。
        for (const note of notes.slice(0, 8)) {
          const scope = Array.isArray(note.entities) && note.entities.length > 0
            ? note.entities.map((entity) => entityOf(entity).label).join('、')
            : '（全部实体）'
          lines.push(`  - ${note.action}（${scope}）：${note.note ?? '（无说明）'}`)
        }
      }
      if (token) {
        try {
          const me = await currentUser({ signal })
          const shown = me.identity?.realname ?? me.identity?.account ?? me.title ?? '（未返回）'
          lines.push(`  当前账号：${shown}`)
          facts.currentUser = redact(me)
        } catch (error) {
          const zerr = asZenTaoError(error)
          lines.push(`  当前账号：读取失败 —— [${zerr.code}] ${zerr.message}`)
        }
      }
      lines.push('', `缓存：${config.cacheTtlSeconds}s TTL；扫描上限 ${SCAN_BOUNDS.maxPagesPerList} 页/列表`)
      // 持久化状态必须可见：降级为纯内存会**缩短幂等窗口**
      //（重启后重放同一次写会被当成新写），用户有知情权。
      if (typeof store.storageStatus === 'function') {
        try {
          const persistence = await store.storageStatus()
          lines.push(persistence.mode === 'storage-domain'
            ? '持久化：已启用（探测结论与幂等记录跨重启保留）'
            : `持久化：仅内存 —— ${persistence.reason}（探测结论需重新探测；幂等窗口不跨重启）`)
          facts.persistence = persistence
        } catch (error) {
          lines.push(`持久化：状态读取失败（${error?.message ?? error}）`)
        }
      }
      return { text: lines.join('\n'), facts, ok: true }
    } catch (error) {
      const zerr = asZenTaoError(error)
      facts.error = { code: zerr.code, message: zerr.message, facts: redact(zerr.facts) }
      lines.push('', `探测失败：[${zerr.code}] ${zerr.message}`, `建议：${zerr.hint}`)
      return { text: lines.join('\n'), facts, ok: false }
    }
  }

  /**
   * 只读端点扫描（§7.6 校准的取证工具）。
   *
   * 对着真实禅道**逐个实体发一次 GET**，报告：路径、HTTP 状态、是否 HTML、
   * 响应信封的键名、首条的**字段名**与状态样本值。字段名与状态样本正是归一化与
   * 状态映射表需要标定的东西；把这份报告贴回来就能把 §7.6 的六项收口。
   *
   * **只读保证**：只调用 listSpec 与 meSpec（都是 GET），绝不发任何写请求。
   * 单条失败不会中断整轮扫描 —— 报告"哪个实体不可用"本身就是结论。
   */
  async function sweep ({ signal, include } = {}) {
    const dialect = await resolveDialect()
    const config = getConfig()
    const token = await authHeaders()
    const wanted = Array.isArray(include) && include.length > 0 ? new Set(include) : undefined
    const probes = []
    const discovered = {}
    const skipped = []

    /** 探一个实体一次；把可用性、信封与字段名一并记下来。 */
    const probeOne = async (entity, scope) => {
      const record = { entity, scope: { ...scope } }
      try {
        const spec = dialect.listSpec(entity, { scope, page: 1, limit: 2 })
        record.method = spec.method
        // 报告**实际请求路径**（含 /api.php/v1 前缀），这样拿真实实例校准时
        // 可以直接复制去试
        record.path = `${dialect.basePath ?? ''}${spec.path}`
        const response = await transport.request({
          base: apiBase(dialect, config),
          method: spec.method,
          path: spec.path,
          query: spec.query,
          headers: dialect.authHeaders(token),
          signal,
        })
        record.status = response.status
        record.ok = response.ok === true
        record.contentType = response.contentType
        if (looksLikeHtml(response)) record.html = true
        if (response.ok) {
          const parsed = dialect.parsePage(entity, response.json)
          const raw = pickArray(parsed?.json ?? response.json, entityOf(entity).plural)
          record.itemCount = raw.length
          record.meta = pickPageMeta(response.json)
          if (response.json !== null && typeof response.json === 'object' && !Array.isArray(response.json)) {
            record.envelopeKeys = Object.keys(response.json).slice(0, 12)
          }
          const first = raw[0]
          if (first !== null && typeof first === 'object') {
            record.fieldNames = Object.keys(first).slice(0, 40)
            record.idSample = first.id
            record.statusSample = first.status
            record.priSample = first.pri
            record.assignedSample = first.assignedTo === null || first.assignedTo === undefined
              ? undefined
              : (typeof first.assignedTo === 'object' ? 'object' : 'string')
          }
          discovered[`${entity}Id`] = record.idSample === undefined ? undefined : String(record.idSample)
        } else {
          const businessError = dialect.detectBusinessError(response.json)
          if (businessError) record.businessError = businessError
          const detail = extractErrorMessage(response.json, response.text)
          if (detail) record.errorHead = detail
        }
      } catch (error) {
        record.errorCode = error?.code ?? 'INTERNAL'
        record.errorMessage = error?.message
      }
      probes.push(record)
      return record
    }

    const shouldProbe = (entity) => wanted === undefined || wanted.has(entity)
    const scopeFor = (entity) => {
      const spec = entityOf(entity)
      if (spec.scope.length === 0) return {}
      if (entity === 'execution') return discovered.projectId ? { project: discovered.projectId } : undefined
      if (entity === 'task') return discovered.executionId ? { execution: discovered.executionId } : undefined
      if (entity === 'bug' || entity === 'plan' || entity === 'testcase') {
        return discovered.productId ? { product: discovered.productId } : undefined
      }
      if (entity === 'build') {
        if (discovered.projectId) return { project: discovered.projectId }
        return discovered.executionId ? { execution: discovered.executionId } : undefined
      }
      if (entity === 'release') {
        if (discovered.productId) return { product: discovered.productId }
        return discovered.projectId ? { project: discovered.projectId } : undefined
      }
      if (entity === 'story') {
        if (discovered.productId) return { product: discovered.productId }
        if (discovered.projectId) return { project: discovered.projectId }
        return discovered.executionId ? { execution: discovered.executionId } : undefined
      }
      return {}
    }

    // 发现阶段：**无论 include 是什么都必须先跑** —— 产品/项目/执行提供其余实体
    // 构造路径所需的 id。若因为"没点名"而跳过，`/zentao sweep task` 就会拿不到
    // execution id，进而拼不出 `/executions/:id/tasks`。
    for (const entity of ['product', 'project']) {
      await probeOne(entity, {})
    }
    if (discovered.projectId !== undefined) {
      await probeOne('execution', { project: discovered.projectId })
    }

    // 报告阶段：其余实体按 include 过滤
    for (const entity of ENTITY_KEYS) {
      if (entity === 'product' || entity === 'project' || entity === 'execution') continue
      if (!shouldProbe(entity)) continue
      const scope = scopeFor(entity)
      if (scope === undefined) {
        skipped.push({ entity, reason: '没有可用于该实体的范围 id（需要先有产品/项目/执行）' })
        continue
      }
      await probeOne(entity, scope)
    }

    // 企业版附加实体：按同规则探一次，让探测结论决定是否值得纳入工具面
    if (wanted === undefined) {
      for (const entity of ENTERPRISE_ENTITY_KEYS) {
        await probeOne(entity, scopeFor(entity) ?? {})
      }
    }

    return {
      dialectId: dialect.id,
      dialectLabel: dialect.label,
      siteLabel: config.label,
      baseURL: config.baseURL,
      probedAt: new Date().toISOString(),
      discovered,
      probes,
      skipped,
      readOnly: true,
      discoveryNote: '产品/项目/执行始终会被探测（它们提供其余实体路径所需的 id），include 只限制其余实体',
    }
  }

  return {
    // 读
    query,
    get,
    my,
    board,
    currentUser,
    // 写
    write,
    // 运维
    doctor,
    reprobe,
    exchangeToken,
    sweep,
    resolveDialect,
    // 便于测试
    _internal: { scanAndFilter, readCurrent, idempotencyKey, validateWriteInput },
  }
}
