/**
 * 禅道 **REST v2** 方言（官方新一代 API，手册第 1 章）。
 *
 * 与 v1 的关系（**刻意复用**，不是重写）：
 *   · 认证头、错误解析、详情解包、网页链接、写操作的**字段语义**都沿用 v1（那些是实测校准过的）；
 *   · **路径与方法**改从官方 SDK 注册表来（`rest-v2.routes.js`，由脚本生成）——
 *     这是官方 CLI 自己用来判定"这个动作在你这台服务器上能不能用"的同一张表；
 *   · v2 注册表里**没有的动作**（assign / log_effort / comment，实测确认注册表里一个都没有）
 *     回退到 v1 的已校准端点，并在 spec 上标 `basePath` 覆盖 —— 宁可走已验证的 v1 形状，
 *     也不凭空猜 v2 的字段。
 *
 * 两条实测事实决定了实现：
 *   1. **v2 没有 `tokens` 端点**（注册表无 token 模块；`POST /api.php/v2/tokens` 落到网页端），
 *      但 **v1 换来的 Token 对 v2 请求有效**（全部 v2 探测都是这么做的）→ 取 Token 永远走 v1；
 *   2. **v2 有服务端筛选**（`browseType` 等列在注册表的 params 里），不像 v1 那样全部被忽略；
 *      分页参数名也不同：v1 是 `page`/`limit`，v2 是 **`pageID`/`recPerPage`**。
 */

import { CODES, ZenTaoError } from '../../domain/errors.js'
import { entityOf } from '../../domain/model.js'
import { unwrapItem } from '../../domain/normalize.js'
import { REST_V1_BASE_PATH, REST_V1_WRITE_BUILDERS, createRestV1Dialect } from './rest-v1.js'
import { v2Action } from './rest-v2.routes.js'

const BASE_PATH = '/api.php/v2'

/** 本插件的实体名 → 官方注册表里的模块名。 */
const MODULE_OF = Object.freeze({
  product: 'product',
  program: 'program',
  project: 'project',
  execution: 'execution',
  plan: 'productplan',
  story: 'story',
  epic: 'epic',
  requirement: 'requirement',
  task: 'task',
  bug: 'bug',
  release: 'release',
  build: 'build',
  testcase: 'testcase',
  testtask: 'testtask',
  user: 'user',
  todo: 'todo',
  issue: 'issue',
  risk: 'risk',
  meeting: 'meeting',
  feedback: 'feedback',
  ticket: 'ticket',
  doc: 'doc',
})

/** scope 键 → 注册表里的路径参数名。 */
const PATH_PARAM_OF = Object.freeze({
  execution: 'executionID',
  product: 'productID',
  project: 'projectID',
  program: 'programID',
})

/** 作用域列表（`/{scope}/{scopeID}/stories`）里的 scope 段名，按优先级排。 */
const SCOPE_SEGMENT = Object.freeze([
  ['execution', 'executions'],
  ['project', 'projects'],
  ['product', 'products'],
])

/** 写动作 → 注册表里的动作名（没有的从这里查不到，走 v1 回退）。 */
const REGISTRY_ACTION_OF = Object.freeze({
  create: 'create',
  update: 'update',
  delete: 'delete',
  start: 'start',
  finish: 'finish',
  close: 'close',
  activate: 'activate',
  change: 'change',
  resolve: 'resolve',
  confirm: 'confirm',
})

/**
 * **v2 与 v1 的字段差异**（全部真机实测）。
 *
 * ① 单值字段：v1 要**数组**（`assignedTo: ['admin']`），v2 要**字符串** ——
 *    实测 `POST /api.php/v2/tasks {assignedTo:['admin']}` 报 `User does not exist.`，
 *    而 `assignedTo: 'admin'`（字符串）成功；`PUT /tasks/{id}` 同理。
 * ② 需要**服务端上下文**的字段（v2 才要求）：实测
 *    · `finish`：缺 `realStarted` 报「『实际开始』不能为空」
 *    · `activate`（任务）：缺 `left` 报「『预计剩余』不能为空」
 *    · `activate`（Bug）：缺 `openedBuild` 报「『影响版本』不能为空」
 *    service 的 `writeSpec` 在**预读实体之前**调用，拿不到当前值，所以这里**本地先校验**，
 *    给出"要传什么"的可读提示（比发出去被服务端拒更好）。
 */
const V1_ARRAY_FIELDS = Object.freeze(['assignedTo', 'reviewer', 'openedBy', 'closedBy', 'canceledBy'])

const V2_EXTRA_REQUIRED = Object.freeze({
  finish: { task: ['realStarted'] },
  activate: { task: ['left'], bug: ['openedBuild'] },
})

/** 已**逐条真机校准**的 v2 写动作（依据见 design 附录 C.42 / C.43 / C.45 的实测记录）。 */
const V2_VERIFIED = Object.freeze({
  task: ['create', 'update', 'delete', 'start', 'finish', 'close', 'activate'],
  bug: ['create', 'update', 'delete', 'resolve', 'close', 'confirm', 'activate'],
  story: ['create', 'update', 'delete', 'close', 'activate'],
})

/**
 * （说明见下方 DETAIL_PATH_OVERRIDES —— 这里只保留一处定义，避免重复声明。）
 */

/**
 * v2 与 v1 的**字段名差异**（逐个实测）。
 * · Bug 创建：v1 用 `product`，而 v2 **必须有 `productID`** —— 实测
 *   `POST /api.php/v2/bugs` 缺它时报 `Missing required parameter: productID.`；
 *   带上（同时保留 product）→ `200 {message,id,status}` 建成功。
 */
function applyV2FieldNames (action, entity, body, payload, scope = {}) {
  if (action === 'create' && entity === 'bug') {
    // ⚠️ `product` 在 v1 是**路径参数**（`/products/{id}/bugs`），所以它不在 BUG_CREATE_FIELDS 里，
    // 也就不可能出现在 v1 构造出的 body 里 —— 必须从 payload / scope 里取。
    const productID = body?.productID ?? payload?.productID ?? payload?.product ?? scope.product
    if (productID !== undefined && productID !== null && productID !== '' && body.productID === undefined) {
      body.productID = productID
    }
  }
  return body
}

/**
 * 注册表**没有列出**、但实测**确实存在**的详情路径。
 *
 * 真机依据（2026-10-08 同批探测，全部返回 **API 级**响应而不是 404/网页）：
 *   GET /api.php/v2/projects/1    → 200 {status, project:{…}}
 *   GET /api.php/v2/builds/1      → 200 {"status":"fail","message":"Build does not exist."}
 *   GET /api.php/v2/releases/1    → 200 {"status":"fail","message":"抱歉，您访问的对象不存在！"}
 *   GET /api.php/v2/testtasks/1   → 200 {"status":"fail","message":"Testtask does not exist."}
 *   GET /api.php/v2/testcases/1   → 200 {"status":"fail","message":"Case does not exist."}
 * （`todos/1` 是 **404 Not found** —— 那条不算，留作真实边界。）
 *
 * 判定要点：**"对象不存在"是 API 级错误，说明路由存在**；404 / HTML 才是没有这条路由。
 * 这类特例逐个登记，不靠猜路径。
 */
const DETAIL_PATH_OVERRIDES = Object.freeze({
  project: (id) => `/projects/${encodeURIComponent(String(id))}`,
  build: (id) => `/builds/${encodeURIComponent(String(id))}`,
  release: (id) => `/releases/${encodeURIComponent(String(id))}`,
  testtask: (id) => `/testtasks/${encodeURIComponent(String(id))}`,
  testcase: (id) => `/testcases/${encodeURIComponent(String(id))}`,
})

/**
 * 说明：v2 的哪些写要用"更新字段"表达（见 `writeSpec` 里的实现）。
 *
 * 真机依据：
 * · **裸 `POST /api.php/v2/stories` 不是 API 路由** —— 它返回的是网页端登录页 JSON
 *   （`data` 里含 `"title":"用户登录"`、`loginExpired:true`）。真路径是**项目作用域**的
 *   `POST /projects/{projectID}/stories`（实测返回 API 校验错误，说明路由是真的）。
 * · **指派**：v2 注册表里没有 assign 动作 → 用 `PUT /{plural}/{id} {assignedTo}`（实测 Bug 的
 *   assignedTo 由 "" → "admin" 且 assignedDate 变化）。
 * · **工时**：v2 没有任何 effort/estimate/worklog 端点 → 用 `PUT /{plural}/{id} {consumed,left}`，
 *   但实测这**只改聚合值、不产生工时明细**；v1 的 /estimate 在本机 IPD 5.6 上同样无效。
 */

/**
 * 识别"HTTP 200 但其实打到了网页端"的载荷。
 *
 * 真机实例：`{"status":"success","data":"{\"title\":\"用户登录\",…\"loginExpired\":true,…}"}`
 * —— 如果把它当成成功，就会出现**假成功**（写过没写成功却报 ok）。宁可报错也不能这样。
 */
function looksLikeWebPagePayload (json) {
  if (json === null || typeof json !== 'object') return false
  if (json.loginExpired === true || json.keepLogin !== undefined) return true
  const data = json.data
  if (typeof data === 'string' && /"loginExpired"|"title"\s*:\s*"[^"]*登录/.test(data)) return true
  if (typeof json.referer === 'string' && /\.json$/.test(json.referer)) return true
  return false
}

/** 解析 `ipd5.6` / `biz13.0` 这类版本字符串（只比同一系列）。 */
function parseVersion (raw) {
  const text = String(raw ?? '')
  const match = /(?:^|[^0-9])(\d+)\.(\d+)/.exec(text)
  if (match === null) return undefined
  const series = /^([a-z]+)/i.exec(text)?.[1]?.toLowerCase() ?? ''
  return { series, major: Number(match[1]), minor: Number(match[2]), raw: text }
}

/** 服务器版本是否满足动作要求的 `ipdX.Y`。信息不足时不拦（如实返回 undefined）。 */
function versionAllows (required, server) {
  const need = parseVersion(required)
  const have = parseVersion(server)
  if (need === undefined || have === undefined) return undefined
  if (need.series !== '' && have.series !== '' && need.series !== have.series) return undefined
  if (have.major !== need.major) return have.major > need.major
  return have.minor >= need.minor
}

/**
 * 把注册表里的路径模板填成真实路径。
 * 缺必填路径参数时**明确报错**（而不是拼出带 `{...}` 的坏地址）。
 */
function fillPath (action, params, { what }) {
  return String(action.path).replace(/\{([^}]+)\}/g, (_all, name) => {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
      throw new ZenTaoError(
        CODES.VALIDATION,
        `${what} 需要参数 ${name}（v2 路径是 ${action.path}）。`,
      )
    }
    return encodeURIComponent(String(value))
  })
}

export function createRestV2Dialect ({ base, version, avoidV1 = false } = {}) {
  const v1 = createRestV1Dialect({ base })

  /**
   * 回退到 v1 已校准路径 —— **严格 v2-only 模式下直接报错**（`avoidV1: true`）。
   *
   * 为什么保留这个开关：v2 覆盖不到的动作（例如某些模块注册表里确实没有）如果不报错而悄悄走 v1，
   * 用户以为"全走 v2"就不会成立。所以严格模式宁可失败也要说清楚缺什么。
   */
  const v1Fallback = (spec, detail) => {
    if (avoidV1) {
      throw new ZenTaoError(
        CODES.UNSUPPORTED,
        `strict v2-only：${detail}（v1 回退已被 avoidV1 关闭）。请改用受支持的动作，或把 avoidV1 关掉。`,
        { facts: { avoidV1: true } },
      )
    }
    return { ...spec, basePath: REST_V1_BASE_PATH }
  }

  /** 取注册表动作，并做版本门禁；动作不存在时返回 undefined（由调用方决定回退或报错）。 */
  const actionOf = (moduleName, actionName, { entity, what }) => {
    const action = v2Action(moduleName, actionName)
    if (action === undefined) return undefined
    if (action.ipd !== undefined) {
      const allowed = versionAllows(action.ipd, version)
      if (allowed === false) {
        throw new ZenTaoError(
          CODES.UNSUPPORTED,
          `${what} 需要禅道 ${action.ipd} 及以上，而本站点是 ${version ?? '未知版本'}。`,
          { facts: { action: `${moduleName}.${actionName}`, required: action.ipd, server: version ?? null } },
        )
      }
    }
    return action
  }

  /** 作用域路径参数：`/{scope}/{scopeID}/…` 与 `/{productID}/…` 两类。 */
  const pathParamsOf = (action, scope = {}, entity) => {
    const params = {}
    const wanted = action.pathParams ?? []
    if (wanted.includes('scope') || wanted.includes('scopeID')) {
      for (const [key, segment] of SCOPE_SEGMENT) {
        if (scope[key] !== undefined && scope[key] !== null && scope[key] !== '') {
          params.scope = segment
          params.scopeID = scope[key]
          break
        }
      }
    }
    for (const name of wanted) {
      if (params[name] !== undefined || name === 'scope' || name === 'scopeID') continue
      for (const [scopeKey, paramName] of Object.entries(PATH_PARAM_OF)) {
        if (paramName === name && scope[scopeKey] !== undefined) params[name] = scope[scopeKey]
      }
    }
    // 详情/动作类：路径里只有一个 id 参数（taskID/bugID/storyID/planID…）
    if (Object.keys(params).length === 0 && wanted.length === 1 && scope.id !== undefined) {
      params[wanted[0]] = scope.id
    }
    if (entity !== undefined && Object.keys(params).length === 0 && wanted.length === 1) {
      // 允许调用方直接把 id 放在 scope 里（writeSpec 的路径参数就是 entity 的 id）
      params[wanted[0]] = scope.id
    }
    return params
  }

  return {
    id: 'rest-v2',
    label: '禅道 REST v2（官方新一代 API）',
    implemented: true,
    basePath: BASE_PATH,

    capabilities: {
      tokenAuth: true,
      paging: 'page-limit',
      // v2 的分页参数名与 v1 不同（注册表里 task.list 的 params 写的是 pageID / recPerPage）
      paginationParams: ['pageID', 'recPerPage'],
      // 注册表里列表动作带 browseType / orderBy 等**服务端**参数 —— 与 v1 实测"全被忽略"相反
      serverFilters: true,
      fieldFilter: false,
      relationExpand: false,
      // /my/tasks|bugs|todos|… 是 v2 的聚合端点（ipd5.5+），不必再本地扫描
      myAggregate: true,
      // v2 **没有**工时明细端点（注册表 26 个模块里没有任何 effort/estimate/worklog 动作）；
      // `log_effort` 在 v2 下用 `PUT` 改 consumed/left（只改聚合值，**不产生工时明细**）。
      effortApi: false,
      incremental: false,
      enterpriseEntities: true,
      /** "我是谁"不需要端点：账号来自凭据（官方 SDK 也是这么做的）。 */
      meFromCredentials: true,
      webLinkFormat: '<base>/<entity>-view-<id>.html',
    },

    authHeaders (token) {
      return v1.authHeaders(token)
    },

    /** v2 的登录端点（官方 SDK 用的就是它）：`POST /users/login {account,password}` → `{status,token,user}`。 */
    tokenSpec (account, password) {
      return { method: 'POST', path: '/users/login', body: { account, password } }
    },

    meSpec () {
      // **v2 没有"当前用户"端点**：实测 `GET /api.php/v2/user` 返回 200 + **空体**（非 JSON）。
      // v2 只有 `/users`（列表）与 `/users/{userID}`（详情）。而"我是谁"其实**不需要端点** ——
      // 账号来自凭据（官方 SDK 也是这么做的：它把登录时输入的账号存进 profile）。
      // 所以这里返回 undefined，由 service 用**凭据里的账号**兜底（严格 v2-only 下不会发任何 v1 请求）。
      return undefined
    },

    listSpec (entity, { scope = {}, page = 1, limit, browseType } = {}) {
      const spec = entityOf(entity)
      const moduleName = MODULE_OF[entity]
      if (moduleName === undefined) {
        throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持查询「${spec.label}」（v2 方言）。`)
      }
      const action = actionOf(moduleName, 'list', { entity, what: `查询${spec.label}列表` })
      if (action === undefined) {
        // 注册表里没有列表动作：交给 v1 的已校准路径（严格模式下这一步会直接报错）
        const fallback = v1Fallback(v1.listSpec(entity, { scope, page, limit }),
          `v2 注册表没有 ${moduleName}.list`)
        return { ...fallback, note: `v2 注册表没有 ${moduleName}.list，已回退 v1 路径` }
      }
      const params = pathParamsOf(action, scope, entity)
      const query = {}
      // ⚠️ **默认 browseType=all**：实测 v2 的 `browseType` 默认值是 `unclosed`，
      // 同一个执行 v1 报 9 条、v2 只报 7 条（少掉的正是已关闭的）——加 `browseType=all` 后两边一致。
      // 悄悄少给数据比报错更糟，所以这里显式要"全部"，调用方仍可传自己的 browseType 覆盖。
      if (action.params?.some((param) => param.name === 'browseType')) {
        query.browseType = browseType ?? 'all'
      } else if (browseType !== undefined) {
        query.browseType = browseType
      }
      if (action.params?.some((param) => param.name === 'pageID')) query.pageID = page
      else query.page = page
      if (limit !== undefined && limit !== null) {
        if (action.params?.some((param) => param.name === 'recPerPage')) query.recPerPage = limit
        else query.limit = limit
      }
      return {
        method: action.method,
        path: fillPath(action, params, { what: `查询${spec.label}列表` }),
        query,
      }
    },

    detailSpec (entity, id) {
      const spec = entityOf(entity)
      const moduleName = MODULE_OF[entity]
      const override = DETAIL_PATH_OVERRIDES[entity]
      const action = moduleName === undefined ? undefined : actionOf(moduleName, 'get', { entity, what: `查询${spec.label}详情` })
      if (action === undefined) {
        if (override !== undefined) {
          // 注册表没列出、但实测可用（见 DETAIL_PATH_OVERRIDES 的注释）→ 用实测路径，不回退 v1
          return {
            method: 'GET',
            path: override(id),
            note: `v2 注册表没有 ${moduleName}.get，但该路由实测可用（已登记为特例）`,
          }
        }
        // 其余情况：回退 v1 已校准路径（严格模式下直接报错）
        const fallback = v1Fallback(v1.detailSpec(entity, id), `v2 注册表没有 ${moduleName}.get`)
        return { ...fallback, note: `v2 注册表没有 ${moduleName}.get，已回退 v1 路径` }
      }
      return {
        method: action.method,
        path: fillPath(action, { [action.pathParams?.[0] ?? 'id']: id }, { what: `查询${spec.label}详情` }),
      }
    },

    writeSpec (action, { entity, id, payload = {}, scope = {} } = {}) {
      const moduleName = MODULE_OF[entity]
      const registryName = REGISTRY_ACTION_OF[action]

      // ── v2 **没有**对应动作名的两类操作：用 v2 的**更新**表达（实测校准，见 C.45）──
      // · assign（指派）：v2 注册表里没有 assign 动作 → `PUT /{plural}/{id} {assignedTo}`。
      //   实测 Bug 的 assignedTo 由 "" → "admin" 且 assignedDate 变化 ✓；任务/需求同理（更新字段）。
      // · log_effort（工时）：v2 没有任何 effort/estimate/worklog 端点 → `PUT /{plural}/{id} {consumed,left}`。
      //   ⚠️ 实测：这只改**聚合值**，**不会产生工时明细**（zt_effort 没有新行）。结果里必须如实说明。
      if (action === 'assign' || action === 'log_effort') {
        const plural = entityOf(entity).plural
        const body = {}
        if (action === 'assign') {
          const assignee = payload.assignedTo ?? payload.assignee
          if (assignee === undefined || assignee === null || String(assignee).trim() === '') {
            throw new ZenTaoError(CODES.VALIDATION, '指派需要 assignedTo（禅道账号名）。')
          }
          body.assignedTo = Array.isArray(assignee) ? assignee[0] : String(assignee).trim()
          // v1 的任务指派还要求 left；v2 的更新里 left 是普通可写字段，给了就带上
          if (payload.left !== undefined) body.left = payload.left
          if (payload.comment !== undefined) body.comment = payload.comment
        } else {
          if (payload.consumed === undefined) {
            throw new ZenTaoError(CODES.VALIDATION, '登记工时需要 consumed（本次消耗工时）。')
          }
          body.consumed = payload.consumed
          if (payload.left !== undefined) body.left = payload.left
          if (payload.work !== undefined) body.work = payload.work
        }
        return {
          method: 'PUT',
          path: `/${plural}/${encodeURIComponent(String(id))}`,
          body,
          dropped: [],
          // 这两个动作**已真机校准**：服务端回读校验真的比对了字段并报 verified=true
          // （assign：assignedTo 由 "" → "admin" 且 assignedDate 变化；log_effort：consumed/left 真的被改）。
          verified: true,
          note: action === 'assign'
            ? `v2 没有 assign 动作，改用更新字段（PUT /${plural}/{id} assignedTo）`
            : `v2 没有任何工时端点，改用更新字段（PUT /${plural}/{id} consumed/left）—— ⚠️ 只改聚合值，` +
              '**不会产生工时明细**（实测 zt_effort 无新行；v1 的 estimate 端点在本机 IPD 5.6 上同样无效）',
        }
      }

      const registryAction = moduleName === undefined || registryName === undefined
        ? undefined
        : actionOf(moduleName, registryName, { entity, what: `${action} ${entityOf(entity).label}` })

      if (registryAction === undefined) {
        if (action === 'comment') {
          throw new ZenTaoError(
            CODES.UNSUPPORTED,
            '严格 v2-only：`comment` 在 v2 与 v1 都**没有**独立端点（v1 的路由表里也没有），无法实现。' +
            '给任务/Bug 留言请用对应动作的 comment 字段（start/finish/close/resolve 都支持）。',
          )
        }
        throw new ZenTaoError(
          CODES.UNSUPPORTED,
          `严格 v2-only：v2 注册表里没有 ${action} 对应的动作（${moduleName ?? entity}.${registryName ?? action}）。` +
          '请改用受支持的动作，或把 avoidV1 关掉以允许回退 v1。',
        )
      }

      // **字段语义复用 v1**（那些是逐条实测过的白名单与必填校验）；路径来自 v2 注册表
      const v1Built = REST_V1_WRITE_BUILDERS[action]?.({ entity, id, payload, scope })

      let body = v1Built?.body
      let dropped = v1Built?.dropped ?? []
      if (body === undefined) {
        const bodyParams = (registryAction.params ?? []).filter((param) => param.in !== 'path' && param.in !== 'query')
        const missing = bodyParams
          .filter((param) => param.required === true)
          .map((param) => param.name)
          .filter((name) => payload?.[name] === undefined && id === undefined)
        if (missing.length > 0) {
          throw new ZenTaoError(
            CODES.VALIDATION,
            `${action} ${entityOf(entity).label} 缺少必填参数：${missing.join('、')}（依据官方 v2 注册表）。`,
          )
        }
        body = { ...payload }
        dropped = []
      }

      // ── 需求创建：v2 的真路径是**项目作用域** ──
      // 实测：裸 `POST /stories` 在这台 IPD 5.6 上返回的是**网页端登录页 JSON**（不是 API），
      // 而 `POST /projects/{projectID}/stories` 返回的是**API 校验错误**（说明路由是真的）。
      if (action === 'create' && entity === 'story') {
        const projectID = payload.project ?? scope.project
        if (projectID === undefined || projectID === '') {
          throw new ZenTaoError(
            CODES.VALIDATION,
            'v2 新建需求需要**项目作用域**：请传 payload.project（项目 ID）。' +
            '实测裸 POST /stories 在本机服务器上不是 API 路由（返回网页端响应）。',
            { facts: { requires: 'project' } },
          )
        }
        return {
          method: 'POST',
          path: `/projects/${encodeURIComponent(String(projectID))}/stories`,
          body,
          dropped,
          verified: false,
          note: '路径来自官方 v2 注册表（project.createStory）；字段语义沿用 v1 实测白名单 —— 待逐条真机校准',
        }
      }

      // 路径参数：单 id 动作（finish/close/resolve/confirm…）与集合动作（create）分开处理
      const wanted = registryAction.pathParams ?? []
      const params = {}
      for (const name of wanted) {
        if (name.toLowerCase().endsWith('id')) params[name] = id
      }
      const filled = wanted.length === 0
        ? registryAction.path
        : fillPath(registryAction, params, { what: `${action} ${entityOf(entity).label}` })

      // ── v2 的字段差异（实测）──
      // ① 单值字段要字符串（v1 要数组）
      for (const key of V1_ARRAY_FIELDS) {
        const value = body?.[key]
        if (Array.isArray(value) && value.length === 1) body[key] = value[0]
      }
      // ①b 字段名差异（Bug 创建要 productID）
      body = applyV2FieldNames(action, entity, body, payload, scope)
      // ② v2 才要求的上下文字段：本地先校验并给出"要传什么"的提示
      const extra = V2_EXTRA_REQUIRED[action]?.[entity] ?? []
      const missingExtra = extra.filter((key) => body?.[key] === undefined || body[key] === '')
      if (missingExtra.length > 0) {
        throw new ZenTaoError(
          CODES.VALIDATION,
          `v2 的「${action} ${entityOf(entity).label}」还需要字段：${missingExtra.join('、')}（实测服务端强制要求）。` +
          '请先 zentao_get 读一次该对象，把当前值随 payload 一起传入。',
          { facts: { action, entity, required: extra } },
        )
      }

      const verifiedList = V2_VERIFIED[entity] ?? []
      return {
        method: registryAction.method,
        path: filled,
        body,
        dropped,
        verified: verifiedList.includes(action),
        note: `路径来自官方 v2 注册表（${moduleName}.${registryName}）；` +
          (verifiedList.includes(action)
            ? '该动作已在真机逐条校准（见 design 附录 C.42 / C.43）'
            : '尚未逐条真机校准'),
      }
    },

    parsePage (entity) {
      const moduleName = MODULE_OF[entity]
      const action = moduleName === undefined ? undefined : v2Action(moduleName, 'list')
      return { plural: action?.getter ?? entityOf(entity).plural }
    },

    parseItem (entity, json) {
      // ⚠️ 解包用的键名是**模块名**而不是实体名：实测 `GET /api.php/v2/productplans/1`
      // 返回 `{status, productplan, actions}` —— 单数键是 `productplan`，
      // 而我的实体名是 `plan`，用实体名解包会取不到 id（真机踩过）。
      const moduleName = MODULE_OF[entity] ?? entity
      return unwrapItem(json, moduleName, entityOf(entity).plural) ?? unwrapItem(json, entity, entityOf(entity).plural)
    },

    parseError (response, options) {
      return v1.parseError(response, options)
    },

    detectBusinessError (json) {
      const v1Error = v1.detectBusinessError(json)
      if (v1Error !== undefined) return v1Error
      // **HTTP 200 但打到了网页端**（实测：`POST /api.php/v2/stories` 返回登录页 JSON）。
      // 不识别它就会"假成功"——写过没写成功却报 ok，这是最不能容忍的一类错误。
      if (looksLikeWebPagePayload(json)) {
        return '禅道返回的是网页端响应（不是 API 响应）：该路由可能未按注册表工作，或登录态已失效'
      }
      // v2 的业务失败形状（实测）：HTTP 200 + { status:'fail', message:{…} 或字符串 }
      if (json !== null && typeof json === 'object' && String(json.status).toLowerCase() === 'fail') {
        const message = json.message
        if (typeof message === 'string' && message.trim() !== '') return message.trim()
        if (message !== null && typeof message === 'object') {
          const flat = Object.values(message).flat().filter((item) => typeof item === 'string')
          if (flat.length > 0) return flat.join('；')
        }
        return '禅道返回 status=fail'
      }
      return undefined
    },

    webLink (baseUrl, entity, id) {
      return v1.webLink(baseUrl, entity, id)
    },
  }
}

export { BASE_PATH as REST_V2_BASE_PATH, MODULE_OF as REST_V2_MODULE_OF }
