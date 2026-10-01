/**
 * 测试助手：伪传输、内存 store、配置快照。
 *
 * 为什么伪传输够用：`src/transport/client.js` 只依赖注入进来的 `fetchImpl`，
 * 而所有业务逻辑都在 `service.js` 与方言里 —— 于是"并发写、幂等、回读、扫描边界"
 * 这些最需要验证的行为可以完全离线跑，不需要真禅道。
 */

import { Transport } from '../src/transport/client.js'

/** 造一个够像 Response 的对象（Transport 只用到这几个成员）。 */
export function respond (status, json, contentType = 'application/json') {
  const text = json === undefined ? '' : JSON.stringify(json)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get (name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null
      },
    },
    async text () {
      return text
    },
    // 让测试能拿到原始 json
    json,
  }
}

/** HTML 响应（探测梯用来识别"打到了网页"）。 */
export function respondHtml (status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html' : null) },
    async text () { return '<!DOCTYPE html><html><body>login</body></html>' },
  }
}

/**
 * @param {Record<string, Function|object>} routes  键为 `"GET /products"`（**不含** API 前缀）
 * @param {{ delayMs?: number, onCall?: Function, stripPrefix?: string|null }} [options]
 *
 * 路径匹配默认会剥掉 `/api.php/v1` 前缀，这样路由键可以写成禅道的资源路径；
 * 而 `calls[].pathname` 保留**完整**路径，因此测试仍然能断言"前缀确实带上了"。
 */
export function createFakeTransport (routes, options = {}) {
  const calls = []
  let active = 0
  let maxActive = 0
  const concurrencyByKey = new Map()
  const stripPrefix = options.stripPrefix === undefined ? '/api.php/v1' : options.stripPrefix

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    const fullPath = parsed.pathname
    const matched = stripPrefix && fullPath.startsWith(stripPrefix)
      ? fullPath.slice(stripPrefix.length) || '/'
      : fullPath
    const key = `${init.method} ${matched}`
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ key, pathname: fullPath, matchedPath: matched, search: parsed.searchParams, method: init.method, body, headers: init.headers })

    active += 1
    maxActive = Math.max(maxActive, active)
    concurrencyByKey.set(key, Math.max(concurrencyByKey.get(key) ?? 0, active))
    try {
      const handler = routes[key]
      if (!handler) return respond(404, { error: `no route for ${key}` })
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const result = typeof handler === 'function'
        ? await handler({ url: parsed, params: parsed.searchParams, body, method: init.method, headers: init.headers })
        : handler
      if (result && result.__html) return respondHtml(result.status ?? 200)
      // `__empty` 用来模拟"2xx 但响应体为空"（DELETE 成功、或网关吞掉了 body）
      if (result && result.__empty) return respond(result.status ?? 200, undefined)
      // `__body` 用来指定**精确的**响应体（包括 JSON null —— 用 `??` 兜底会被吞掉）
      if (result && '__body' in result) return respond(result.status ?? 200, result.__body)
      return respond(result?.status ?? 200, result?.json ?? result?.body ?? result)
    } finally {
      active -= 1
    }
  }

  const transport = new Transport({
    fetchImpl,
    getTimeoutMs: () => options.timeoutMs ?? 5000,
    getMaxRetries: () => options.maxRetries ?? 0,
  })

  return {
    transport,
    calls,
    get maxConcurrent () { return maxActive },
    concurrencyByKey,
    callsTo (key) { return calls.filter((call) => call.key === key) },
  }
}

/** 内存 store（与 src/store.js 的接口一致）。 */
export function createMemoryStore (seed = {}) {
  const entities = new Map()
  const idempotency = new Map()
  let probe = seed.probe
  return {
    async getProbe () { return probe },
    async setProbe (record) { probe = record; return record },
    async getEntity (entity, id) { return entities.get(`${entity}:${id}`) },
    async setEntity (entity, id, record) { entities.set(`${entity}:${id}`, record); return record },
    async getIdempotency (key) { return idempotency.get(key) },
    async setIdempotency (key, record) { idempotency.set(key, record); return record },
    async storageStatus () { return { mode: 'memory-only', reason: '测试夹具' } },
    async close () {},
    _entities: entities,
    _idempotency: idempotency,
  }
}

/** 配置快照（与 snapshotConfig 的输出同形）。 */
export function fakeConfig (overrides = {}) {
  return {
    baseURL: 'https://zt.example.com',
    label: '测试禅道',
    accountRef: 'ZENTAO_ACCOUNT',
    passwordRef: 'ZENTAO_PASSWORD',
    dialect: 'rest-v1',
    writePolicy: 'confirm',
    allowBulkWrite: false,
    maxBulkItems: 20,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    maxPageSize: 50,
    maxResultItems: 20,
    cacheTtlSeconds: 300,
    includeRawPayload: false,
    includeWebLinks: true,
    stripRichText: 'strip',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }
}

/** 一个任务的原始载荷（照抄手册 1083 的响应示例，含实证陷阱）。 */
export function rawTask (overrides = {}) {
  return {
    id: 18,
    project: 12,
    parent: 0,
    execution: 13,
    module: 0,
    story: 0,
    name: 'task1',
    type: 'devel',
    pri: 3,
    estimate: 0,
    consumed: 2,
    left: 0,
    deadline: null,
    status: 'done',
    desc: '<p>hello <b>world</b></p>',
    version: 1,
    openedBy: { id: 1, account: 'admin', avatar: '', realname: 'administrator' },
    openedDate: '2021-11-29T02:33:47Z',
    assignedTo: { id: 1, account: 'admin', avatar: '', realname: 'administrator' },
    assignedToRealName: 'administrator',
    estStarted: '0000-00-00',
    realStarted: '2021-11-29T02:50:00Z',
    lastEditedDate: '2021-11-29T02:52:25Z',
    deleted: false,
    progress: 100,
    ...overrides,
  }
}

/** 列表信封（照抄手册的 `{page,total,limit,tasks}` 形状）。 */
export function listEnvelope (plural, items, { page = 1, limit = 50, total } = {}) {
  return { page, total: total ?? items.length, limit, [plural]: items }
}
