/**
 * 方言 A：禅道 REST v1（`<base>/api.php/v1/...`，请求头 `Token`）。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 *
 * 核验等级（每一处都标注）：
 *   [文档]  官方《二次开发》手册明文给出的方法/路径/字段表。
 *   [推断]  由 [文档] 同类端点外推（例如 task 的 suspend/continue 未抓页面）。
 *           `verified` 置 false，dryRun 会显示真实请求行、/zentao doctor 会报告。
 *
 * 关键事实（全部来自手册原文，不是猜的）：
 *   - 认证头 `Token`（有一页写小写 `token`，HTTP 头大小写不敏感）。
 *   - 列表：`GET /projects`、`GET /users` 明文接受 `page` + `limit`（不是 `recPerPage`）；
 *     任务列表页**没有**请求参数表。响应侧统一是 `{page,total,limit,<集合键>}`。
 *   - 详情：**裸对象**（`GET /tasks/:id` 示例第一层就是 `{"id":22,...}`）。
 *   - 写操作**两类并存**：
 *       标准 REST：`POST /executions/:id/tasks`、`POST /products/:id/bugs`、`POST /stories`、
 *                  `PUT /tasks/:id`、`PUT /bugs/:id`、`DELETE /tasks/:id`、`DELETE /bugs/:id`
 *       动作式：  `POST /tasks/:id/start`、`POST /tasks/:id/finish`、`POST /stories/:id/change`
 *   - **`PUT /tasks/:id` 与 `PUT /bugs/:id` 的字段表里没有 `status`** → 改状态必须走动作端点。
 *     这是本文件最要紧的一条：把"改状态"错误地做成 PUT status 会静默失败。
 */

import { CODES, ZenTaoError, codeForStatus, redact } from '../../domain/errors.js'
import {
  BUG_CREATE_FIELDS, BUG_UPDATE_FIELDS, STORY_CHANGE_FIELDS, STORY_CREATE_FIELDS,
  TASK_CREATE_FIELDS, TASK_FINISH_FIELDS, TASK_START_FIELDS, TASK_UPDATE_FIELDS,
  entityOf, writeActionOf,
} from '../../domain/model.js'
import { unwrapItem } from '../../domain/normalize.js'
import { extractErrorMessage } from '../client.js'

const BASE_PATH = '/api.php/v1'

/** 列表路径。[文档] 带父资源的实体必须校验范围，否则会拼出 `/executions/undefined/tasks` 这种坏 URL。 */
const LIST_PATHS = {
  product: () => '/products',
  project: () => '/projects',
  program: () => '/programs',
  execution: (scope) => `/projects/${need(scope.project, 'project', 'execution')}/executions`,
  story: (scope) => {
    if (scope.product) return `/products/${scope.product}/stories`
    if (scope.project) return `/projects/${scope.project}/stories`
    if (scope.execution) return `/executions/${scope.execution}/stories`
    throw missingScope('story', 'product / project / execution')
  },
  task: (scope) => `/executions/${need(scope.execution, 'execution', 'task')}/tasks`,
  bug: (scope) => `/products/${need(scope.product, 'product', 'bug')}/bugs`,
  user: () => '/users',
  plan: (scope) => `/products/${need(scope.product, 'product', 'plan')}/plans`,
  release: (scope) => (scope.product
    ? `/products/${scope.product}/releases`
    : `/projects/${need(scope.project, 'project', 'release')}/releases`),
  build: (scope) => (scope.project
    ? `/projects/${scope.project}/builds`
    : `/executions/${need(scope.execution, 'execution', 'build')}/builds`),
  testcase: (scope) => `/products/${need(scope.product, 'product', 'testcase')}/testcases`,
  // 实测（IPD 5.6）：**不带范围**的 `GET /testtasks` 返回 200 但 body 为空（0 字节，不可用）；
  // 而**带项目范围**的 `GET /projects/:id/testtasks` 返回正常信封 {page,total,limit,testtasks}。
  // 权威路由表（config/apiv1.php L147-149）确认两者都存在，因此要求项目范围而不是整体判为不可用。
  testtask: (scope) => `/projects/${need(scope.project, 'project', 'testtask')}/testtasks`,
  feedback: () => '/feedbacks',
  ticket: () => '/tickets',
}

/** 详情路径。[文档]（手册第 2 章每个实体都有 detail 页，形状为裸对象）
 *  **实测修正**：详情路径的资源名是**复数**（`/bugs/1` ✓ 而 `/bug/1` ✗ 404），
 *  且不一定等于列表路径里的那一段：
 *   · 计划的列表是 `/products/:id/plans`，但详情是 **`/productplans/:id`**（`/plans/:id` 实测 404 不存在）；
 *   · 其余实测存在的详情路径：`/releases/:id`、`/builds/:id`、`/testcases/:id`、`/testtasks/:id`。
 *  判定"路由是否存在"的方法（不需要造记录）：`{"error":"not found"}`（小写）= 路由不存在；
 *  其它任何错误（`"404 Not found"`、`"抱歉，您访问的对象不存在！"`、域名错误）= 路由存在、只是记录不存在。
 */
const DETAIL_PATHS = {
  product: (id) => `/products/${id}`,
  project: (id) => `/projects/${id}`,
  program: (id) => `/programs/${id}`,
  execution: (id) => `/executions/${id}`,
  story: (id) => `/stories/${id}`,
  task: (id) => `/tasks/${id}`,
  bug: (id) => `/bugs/${id}`,
  user: (id) => `/users/${id}`,
  plan: (id) => `/productplans/${id}`,
  release: (id) => `/releases/${id}`,
  build: (id) => `/builds/${id}`,
  testcase: (id) => `/testcases/${id}`,
  testtask: (id) => `/testtasks/${id}`,
  feedback: (id) => `/feedbacks/${id}`,
  ticket: (id) => `/tickets/${id}`,
}

function missingScope (entity, key) {
  const spec = entityOf(entity)
  const wanted = key ?? spec.scope.join(' 或 ')
  return new ZenTaoError(
    CODES.VALIDATION,
    `${spec.label}必须指定范围：scope 需要 ${wanted}` +
    '（禅道 v1 的端点形态如此：任务挂在执行下、Bug 挂在产品下）。',
    { hint: '例如 scope: { execution: "13" }；范围 id 可先用 zentao_query 查 project / product。' },
  )
}

/** 取必需的 scope 键，缺失即抛出精准错误。 */
function need (value, key, entity) {
  if (value === undefined || value === null || value === '') throw missingScope(entity, key)
  return value
}

function requireId (id, what) {
  if (id === undefined || id === null || id === '') {
    throw new ZenTaoError(CODES.VALIDATION, `${what}必须提供 id。`)
  }
  return String(id)
}

/**
 * 只挑出**文档化**的字段，并如实汇报被丢弃的字段。
 * 之所以要汇报而不是静默丢弃：模型写了一个禅道不接受的字段名时，
 * 静默成功会让它以为改生效了 —— 这正是"看起来成功其实没做"。
 */
function pickFields (source, allowed) {
  const input = source && typeof source === 'object' ? source : {}
  const body = {}
  const dropped = []
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (allowed.includes(key)) body[key] = value
    else dropped.push(key)
  }
  return { body, dropped }
}

function toArray (value) {
  if (value === undefined || value === null) return undefined
  return Array.isArray(value) ? value : [value]
}

/**
 * 每个「动作 × 实体」组合是否已确认。
 *
 * 两种来源：**手册明文**，或**在本机真实禅道（IPD 版）上实测成功**。
 * 未列出的组合 → 请求形状是外推的 → 由 allowUnverifiedWrites 闸门默认拦住。
 */
function verified (action, entity) {
  const table = {
    // create/update：手册明文；且 Bug/需求/任务的 create 已在本机实测成功
    create: ['task', 'bug', 'story'],
    update: ['task', 'bug', 'story'],
    // 实测确认：POST /tasks/:id/start 与 /finish 都成功（start 后 doing/left=2/consumed=2；finish 后 done/consumed=4）
    start: ['task'],
    finish: ['task'],
    // 实测确认：任务走 POST /tasks/:id/assignto（**left 必填**），Bug 走 POST /bugs/:id/assign，
    // 需求走 POST /stories/:id/assign（路由表 L67；三者的字段与必填项都取自 api/v1/entries/）
    assign: ['task', 'bug', 'story'],
    // 实测确认：DELETE /bugs/:id 与 DELETE /stories/:id 都是**软删除**（deleted=true，列表不再返回）
    delete: ['task', 'bug', 'story'],
    // 实测**反证**：PUT 详情带 comment 返回 200 却不产生动作记录；
    // 且权威路由表 config/apiv1.php 里**根本没有任何 comment 路由** → 该动作不可用
    comment: [],
    // 实测确认：POST /bugs/:id/resolve 需要 resolution + resolvedBuild
    resolve: ['bug'],
    // 实测确认：POST /bugs/:id/close、/tasks/:id/close、/stories/:id/close 都成功
    //（任务 done→closed；需求 reviewing→closed，需 closedReason）
    close: ['bug', 'task', 'story'],
    // 实测确认（三次修正后的真实端点）：POST /tasks/:id/estimate {date,consumed,left,work}、
    // POST /bugs/:id/estimate {dates,consumed,work}、POST /stories/:id/estimate
    log_effort: ['task', 'bug', 'story'],
  }
  return (table[action] ?? []).includes(entity)
}

const NOTES = {
  create: '新建任务走 POST /executions/:id/tasks，新建 Bug 走 POST /products/:id/bugs，新建需求走 POST /stories —— ' +
    '任务必须在 payload（或 scope）里给出 execution，Bug 必须给出 product。' +
    '实测必填：Bug 的 type；**需求的 spec（描述）**；需求的 category（产品开启评审时还要 reviewer）。' +
    '**数组形态**：任务的 assignedTo 与需求的 reviewer 都要传数组（如 ["admin"] / [2]）——' +
    '传字符串或数字会被判成"不能为空"。',
  update: 'PUT 的字段表里**没有 status**：任务改状态要用 start/finish 动作，Bug 改状态要用 resolve/close。' +
    '需求只提供 POST /stories/:id/change（title/spec/verify）。实测：PUT /bugs/:id 改 pri 生效并回读一致。',
  start: '实测确认：POST /tasks/:id/start body {left, consumed, realStarted, comment} 成功；' +
    '之后任务 status=doing、left/consumed 按传入值更新。',
  finish: '实测确认：POST /tasks/:id/finish body {currentConsumed, finishedDate, comment} 成功；' +
    '之后 status=done，consumed 累加（2 → 4）。**finishedDate 要带时间**：只给日期会报' +
    '「实际完成不能小于实际开始」（start 会把实际开始盖上时间戳）。',
  assign: '实测确认（端点由 config/apiv1.php 的路由表确证）：任务用 **POST /tasks/:id/assignto**，' +
    'Bug 用 **POST /bugs/:id/assign**，需求用 **POST /stories/:id/assign**。' +
    '**任务必须同时给 left（预计剩余工时）** —— 缺它报「『预计剩余』不能为空。」。',
  comment: '实测**反证**：PUT 详情带 comment 返回 200 却**不产生任何动作记录**；' +
    '而且权威路由表里有 131 个端点却**没有任何 comment 路由** → 该动作在本版本不可用。' +
    '给任务留言请用 start/finish/close 的 comment 字段（那些已实测确认）。',
  resolve: '实测确认：POST /bugs/:id/resolve 成功，**必填 resolution 与 resolvedBuild**' +
    '（缺 resolvedBuild 时报「『解决版本』不能为空。」）。',
  close: '实测确认：POST /bugs/:id/close、/tasks/:id/close、/stories/:id/close 都成功。' +
    '任务的关闭写 comment，需求还要 closedReason（如 willnotdo/done），Bug 的 reason 作为 comment 写入。' +
    '**注意 reason 的映射**：本插件要求写操作提供 reason，方言把 reason 落到禅道认识的 comment 上，' +
    '所以"reason 会被记录"这句话是真的（曾经漏过这层映射，等于无声变更）。',
  delete: '实测确认：Bug 与需求的 DELETE 都是**软删除**（`deleted: true`，详情仍可读但列表不再返回）；' +
    '任务的 DELETE 路径为[文档]，未在本机实测。',
  log_effort: '实测确认（端点经三次修正才对）：**POST /tasks/:id/estimate**（不是 /efforts 也不是 /recordestimate）、' +
    '**POST /bugs/:id/estimate**、**POST /stories/:id/estimate**。' +
    '字段：任务与需求用 {date, consumed, left, work}；Bug 用 {dates, consumed, work}（**没有 left**）。' +
    'consumed（本次消耗）必填；工时记录与任务自身的 consumed/left 是两套数据（实测登记后任务字段未变）。',
}

/** 写操作构造器：返回 { method, path, body, verified, dropped, note }。 */
const WRITE_BUILDERS = {
  create ({ entity, payload = {}, scope = {} }) {
    if (entity === 'task') {
      const execution = payload.execution ?? scope.execution
      if (!execution) {
        throw new ZenTaoError(CODES.VALIDATION,
          '新建任务必须给出所属执行：在 payload 里填 execution，或用 scope.execution 指定。')
      }
      const { body, dropped } = pickFields(payload, TASK_CREATE_FIELDS)
      if (body.assignedTo !== undefined) body.assignedTo = toArray(body.assignedTo)
      return { method: 'POST', path: `/executions/${execution}/tasks`, body, dropped }
    }
    if (entity === 'bug') {
      const product = payload.product ?? scope.product
      if (!product) {
        throw new ZenTaoError(CODES.VALIDATION,
          '新建 Bug 必须给出所属产品：在 payload 里填 product，或用 scope.product 指定。')
      }
      const { body, dropped } = pickFields(payload, BUG_CREATE_FIELDS)
      return { method: 'POST', path: `/products/${product}/bugs`, body, dropped }
    }
    if (entity === 'story') {
      // `project` 只对 **v2** 有意义（它是 v2 的路径作用域 `POST /projects/{id}/stories`），
      // v1 的创建端点没有这个字段 —— 从正文里剔除，只作为"已消费"记在 dropped 里。
      const { project: _project, ...rest } = payload ?? {}
      const { body, dropped } = pickFields(rest, STORY_CREATE_FIELDS.filter((key) => key !== 'project'))
      if (payload?.project !== undefined) dropped.push('project（v1 创建需求没有该字段，仅 v2 用作路径作用域）')
      // 实测：需求创建时『描述』(spec) 必填（缺它服务端报「『描述』不能为空。」）；
      // 另外产品开启评审时 reviewer 必填，且 **reviewer 要传数组**（传字符串/数字会被判成空）。
      if (body.spec === undefined || String(body.spec).trim() === '') {
        throw new ZenTaoError(CODES.VALIDATION, '新建需求必须提供 spec（描述）。')
      }
      if (body.reviewer !== undefined && !Array.isArray(body.reviewer)) {
        throw new ZenTaoError(CODES.VALIDATION,
          'reviewer 必须传数组（如 ["admin"] 或 [2]）—— 实测传字符串或数字会被禅道判成"不能为空"。')
      }
      return { method: 'POST', path: '/stories', body, dropped }
    }
    throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持新建「${entityOf(entity).label}」。`)
  },

  update ({ entity, id, payload = {} }) {
    const target = requireId(id, '修改')
    const patch = payload.patch ?? payload
    if (entity === 'task') {
      const { body, dropped } = pickFields(patch, TASK_UPDATE_FIELDS)
      if (body.assignedTo !== undefined) body.assignedTo = toArray(body.assignedTo)
      return { method: 'PUT', path: `/tasks/${target}`, body, dropped }
    }
    if (entity === 'bug') {
      const { body, dropped } = pickFields(patch, BUG_UPDATE_FIELDS)
      return { method: 'PUT', path: `/bugs/${target}`, body, dropped }
    }
    if (entity === 'story') {
      const { body, dropped } = pickFields(patch, STORY_CHANGE_FIELDS)
      return { method: 'POST', path: `/stories/${target}/change`, body, dropped }
    }
    throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持修改「${entityOf(entity).label}」。`)
  },

  start ({ id, payload = {} }) {
    const target = requireId(id, '开始任务')
    const { body, dropped } = pickFields(payload, TASK_START_FIELDS)
    if (body.left === undefined) {
      throw new ZenTaoError(CODES.VALIDATION, '开始任务必须提供 left（剩余工时，单位小时）。')
    }
    return { method: 'POST', path: `/tasks/${target}/start`, body, dropped }
  },

  finish ({ id, payload = {} }) {
    const target = requireId(id, '完成任务')
    const { body, dropped } = pickFields(payload, TASK_FINISH_FIELDS)
    if (body.currentConsumed === undefined || body.finishedDate === undefined) {
      throw new ZenTaoError(CODES.VALIDATION,
        '完成任务必须提供 currentConsumed（本次消耗工时）与 finishedDate（完成时间，如 2026-03-10 15:30:00）。')
    }
    return { method: 'POST', path: `/tasks/${target}/finish`, body, dropped }
  },

  assign ({ entity, id, payload = {} }) {
    const target = requireId(id, '指派')
    const assignee = payload.assignedTo ?? payload.assignee
    if (assignee === undefined || assignee === null || assignee === '') {
      throw new ZenTaoError(CODES.VALIDATION, '指派必须提供 assignedTo（禅道账号名）。')
    }
    // **实测**：任务与 Bug 都有专门的指派动作端点（api/v1/entries/taskassignto.php、bugassign.php），
    // 优先用它；需求也有（storyassignto.php，路由表 L67 `/stories/:id/assign`，字段 assignedTo/comment）。
    const actionPath = {
      task: `/tasks/${target}/assignto`,
      bug: `/bugs/${target}/assign`,
      story: `/stories/${target}/assign`,
    }[entity]
    if (actionPath) {
      // 实测：任务指派端点会报『预计剩余』不能为空 —— left 实际上是必填的
      if (entity === 'task' && payload.left === undefined) {
        throw new ZenTaoError(CODES.VALIDATION,
          '指派任务必须提供 left（预计剩余工时）—— 实测缺它会报「『预计剩余』不能为空」。')
      }
      const body = { assignedTo: entity === 'bug' ? assignee : toArray(assignee) }
      if (payload.comment !== undefined) body.comment = String(payload.comment)
      if (entity === 'task' && payload.left !== undefined) body.left = payload.left
      if (entity === 'bug' && payload.mailto !== undefined) body.mailto = toArray(payload.mailto)
      return { method: 'POST', path: actionPath, body, dropped: [] }
    }
    const path = DETAIL_PATHS[entity]?.(target) ?? (() => { throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持指派「${entityOf(entity).label}」。`) })()
    const body = { assignedTo: entity === 'task' ? toArray(assignee) : assignee }
    if (payload.comment) body.comment = payload.comment
    return { method: 'PUT', path, body, dropped: [] }
  },

  comment ({ entity, id, payload = {} }) {
    const target = requireId(id, '添加备注')
    const text = payload.comment ?? payload.text
    if (text === undefined || String(text).trim() === '') {
      throw new ZenTaoError(CODES.VALIDATION, '添加备注必须提供 comment（文本）。')
    }
    return { method: 'PUT', path: DETAIL_PATHS[entity](target), body: { comment: String(text) }, dropped: [] }
  },

  resolve ({ id, payload = {} }) {
    const target = requireId(id, '解决 Bug')
    const { body, dropped } = pickFields(payload, ['resolution', 'resolvedBuild', 'resolvedDate', 'assignedTo', 'comment', 'duplicateBug', 'reason'])
    // 同 close：把策略要求的 reason 落到禅道认识的 comment 上（详见 close 的注释）
    if (body.comment === undefined && body.reason !== undefined) body.comment = String(body.reason)
    delete body.reason
    if (body.resolution === undefined) {
      throw new ZenTaoError(CODES.VALIDATION, '解决 Bug 必须提供 resolution（如 fixed / notrepro / duplicate / bydesign / willnotfix）。')
    }
    return { method: 'POST', path: `/bugs/${target}/resolve`, body, dropped }
  },

  close ({ entity, id, payload = {} }) {
    const target = requireId(id, '关闭')
    const path = buildCollectionPath(entity, target)
    if (!path) throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持关闭「${entityOf(entity).label}」。`)
    // 实测：任务关闭要 comment；需求关闭要 closedReason（+可选 duplicateStory/comment）；Bug 关闭要 comment
    const fields = entity === 'story'
      ? ['closedReason', 'duplicateStory', 'comment', 'reason']
      : ['comment', 'closedReason', 'reason']
    const { body, dropped } = pickFields(payload, fields)
    // **策略承诺兑现**：服务层强制要求 reason，并声称"会作为备注写入禅道"。
    // 禅道的关闭端点接受的是 comment，所以在**这里**把 reason 映射过去（否则会被静默丢弃，
    // 那就等于"无声变更"—— 正是这条策略要防的事）。
    if (body.comment === undefined && body.reason !== undefined) body.comment = String(body.reason)
    delete body.reason
    if (entity === 'story' && body.closedReason === undefined) {
      throw new ZenTaoError(CODES.VALIDATION,
        '关闭需求必须提供 closedReason（如 done / willnotdo / duplicate / postpone）。')
    }
    return { method: 'POST', path: `${path}/close`, body, dropped }
  },

  delete ({ entity, id }) {
    const target = requireId(id, '删除')
    if (entity === 'task') return { method: 'DELETE', path: `/tasks/${target}`, dropped: [] }
    if (entity === 'bug') return { method: 'DELETE', path: `/bugs/${target}`, dropped: [] }
    if (entity === 'story') return { method: 'DELETE', path: `/stories/${target}`, dropped: [] }
    throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持删除「${entityOf(entity).label}」。`)
  },

  log_effort ({ entity, id, payload = {} }) {
    const target = requireId(id, '登记工时')
    // **实测修正（两次）**：端点既不是 `/tasks/:id/efforts`（404），也不是 `/tasks/:id/recordestimate`（404）。
    // 权威来源 `config/apiv1.php` 的路由表：`$routes['/tasks/:id/estimate'] = 'taskRecordEstimate'`，
    // Bug 与需求同理（`/bugs/:id/estimate`、`/stories/:id/estimate`）。
    // 字段来自 `api/v1/entries/taskrecordestimate.php`：date, consumed, left, work。
    if (entity === 'bug') {
      const { body, dropped } = pickFields(payload, ['dates', 'consumed', 'work', 'comment'])
      if (body.work === undefined && body.comment !== undefined) body.work = String(body.comment)
      delete body.comment
      if (body.consumed === undefined) {
        throw new ZenTaoError(CODES.VALIDATION, '登记 Bug 工时必须提供 consumed（本次消耗工时）。')
      }
      return { method: 'POST', path: `/bugs/${target}/estimate`, body, dropped }
    }
    if (entity === 'story') {
      const { body, dropped } = pickFields(payload, ['date', 'consumed', 'left', 'work', 'comment'])
      if (body.work === undefined && body.comment !== undefined) body.work = String(body.comment)
      delete body.comment
      if (body.consumed === undefined) {
        throw new ZenTaoError(CODES.VALIDATION, '登记需求工时必须提供 consumed（本次消耗工时）。')
      }
      return { method: 'POST', path: `/stories/${target}/estimate`, body, dropped }
    }
    const { body, dropped } = pickFields(payload, ['date', 'consumed', 'left', 'work', 'comment', 'hours'])
    if (body.work === undefined && body.comment !== undefined) body.work = String(body.comment)
    delete body.comment
    // 兼容旧字段名：hours 视同 consumed（工具说明里曾经写的是 hours）
    if (body.consumed === undefined && body.hours !== undefined) body.consumed = body.hours
    delete body.hours
    if (body.consumed === undefined) {
      throw new ZenTaoError(CODES.VALIDATION, '登记任务工时必须提供 consumed（本次消耗工时）。')
    }
    return { method: 'POST', path: `/tasks/${target}/estimate`, body, dropped }
  },
}

/** 关闭动作需要的集合路径（详情路径去掉 id）。 */
function buildCollectionPath (entity, id) {
  const map = {
    task: `/tasks/${id}`,
    bug: `/bugs/${id}`,
    story: `/stories/${id}`,
  }
  return map[entity]
}

export function createRestV1Dialect ({ base } = {}) {
  return {
    id: 'rest-v1',
    label: '禅道 REST v1',
    implemented: true,
    basePath: BASE_PATH,

    capabilities: {
      tokenAuth: true,
      // /projects 与 /users 明文接受 page+limit；其它列表页未列请求参数，
      // 但我们用**响应回报的有效 limit** 驱动翻页，因此不依赖请求参数被采纳。
      paging: 'page-limit',
      // 实测（本机禅道 IPD 版）：limit=3 → 服务端回 "limit":3；recPerPage/perPage/pageSize 全部被忽略。
      // （recPerPage 是 **v2** 的参数名。）
      paginationParams: ['page', 'limit'],
      // 条件过滤：实测**全部被忽略**（q / title / assignedTo / keywords / browseType / pri / severity
      // 传了不可能匹配的值仍然返回全部条目）→ 过滤只能在本地做（见 domain/query.js 顶部说明）。
      // 这条实测结论正是"本地过滤 + 有界扫描 + 如实报 PARTIAL"这套架构的依据。
      serverFilters: false,
      // **不要传** status：实测 `status=<任意值>`（包括真实状态 closed）都会把结果**清空**为 0 条，
      // 它不是过滤器而是会破坏查询的参数。本方言因此从不发送它。
      harmfulParams: ['status'],
      fieldFilter: false,
      relationExpand: false,
      myAggregate: false,
      effortApi: false,
      incremental: false,
      enterpriseEntities: true,
      // 深链格式由禅道自身代码确证：requestType='PATH_INFO' + .htaccess 重写 + parsePathInfo()
      // 取最后一个 '.' 前的部分作 uri、之后作 viewType('html') + setRouteByPathInfo() 按 requestFix('-')
      // 拆成 module/method/params ⇒ `<base><module>-<method>-<id>.html`。
      webLinkFormat: '<base>/<entity>-view-<id>.html',
    },

    /** [文档] 认证头就叫 `Token`。 */
    authHeaders (token) {
      return token ? { Token: token } : {}
    },

    /** [文档] POST /tokens，正文 {account,password}，响应 {token}。 */
    tokenSpec (account, password) {
      return { method: 'POST', path: '/tokens', body: { account, password } }
    },

    /** [文档] GET /user —— 解析"我是谁"（`zentao_my` 的第一步）。 */
    meSpec () {
      return { method: 'GET', path: '/user' }
    },

    listSpec (entity, { scope = {}, page = 1, limit } = {}) {
      const spec = entityOf(entity)
      const build = LIST_PATHS[entity]
      if (!build) throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持查询「${spec.label}」。`)
      const query = { page }
      if (limit !== undefined && limit !== null) query.limit = limit
      return { method: 'GET', path: build(scope), query }
    },

    detailSpec (entity, id) {
      entityOf(entity)
      const build = DETAIL_PATHS[entity]
      if (!build) throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持查询「${entityOf(entity).label}」详情。`)
      return { method: 'GET', path: build(requireId(id, '查询详情')) }
    },

    writeSpec (action, { entity, id, payload = {}, scope = {} } = {}) {
      // v2 专属动作：v1 上实测不存在（`PUT /tasks/:id/activate`、`/stories/:id/activate` 都是 404；
      // `PUT /bugs/:id/confirm` 返回 200 但**响应体为空**，不可信）。明确报出来 + 给出可行做法。
      if (action === 'activate' || action === 'confirm') {
        throw new ZenTaoError(
          CODES.UNSUPPORTED,
          `REST v1 没有「${action === 'activate' ? '重新激活' : '确认 Bug'}」这个端点（实测 ${action === 'activate' ? '404' : '200 空体，不可信'}）。` +
          '请在设置页把 dialect 设为 auto 或 rest-v2（服务器需支持 v2）。',
        )
      }
      const build = WRITE_BUILDERS[action]
      if (!build) throw new ZenTaoError(CODES.UNSUPPORTED, `暂不支持该写操作："${action}"。`)
      const built = build({ entity, id, payload, scope })
      return {
        method: built.method,
        path: built.path,
        body: built.body,
        dropped: built.dropped ?? [],
        verified: verified(action, entity),
        note: NOTES[action],
      }
    },

    /** 写操作形状是否已全部实测校准（false → `/zentao doctor` 明确报告）。 */
    writeShapesVerified: false,

    /** 列出尚未被真机校准的「动作 × 实体」组合，供诊断如实报告。 */
    listWriteShapeNotes () {
      const out = []
      for (const action of Object.keys(WRITE_BUILDERS)) {
        // **实体列表取自 model.js 的权威声明**，不要在这里另抄一份。
        // 早先这里按"大致如此"硬编码成 ['task','bug'] 之类，于是把 start/finish **根本不支持**的
        // bug 也列成"未校准" —— 那会让用户以为打开 allowUnverifiedWrites 就能开始一个 Bug。
        // （实测：禅道路由表里没有 /bugs/:id/start 或 /bugs/:id/finish。）
        const entities = writeActionOf(action)?.entities ?? []
        const unverified = entities.filter((entity) => !verified(action, entity))
        if (unverified.length > 0) {
          out.push({ action, entities: unverified, note: NOTES[action] })
        }
      }
      return out
    },

    /** [文档] 列表响应信封 `{page,total,limit,<集合键>}`；键名容错见 normalize.pickArray。 */
    parsePage (entity) {
      return { plural: entityOf(entity).plural }
    },

    /** [文档] 详情是**裸对象**；仍保留一层容错（见 unwrapItem）。 */
    parseItem (entity, json) {
      return unwrapItem(json, entity, entityOf(entity).plural)
    },

    parseError (response, { what = '禅道请求' } = {}) {
      const detail = extractErrorMessage(response.json, response.text)
      if (response.status === 401) {
        return new ZenTaoError(CODES.AUTH_EXPIRED, `${what}被拒绝：Token 无效或已失效。`,
          { status: 401, facts: { url: response.url } })
      }
      if (response.status === 404) {
        return new ZenTaoError(CODES.NOT_FOUND,
          `${what}找不到目标（HTTP 404）${detail ? `：${detail}` : ''}`,
          { status: 404, facts: { url: response.url, method: response.method } })
      }
      if (response.status === 409) {
        return new ZenTaoError(CODES.CONFLICT,
          `${what}发生版本冲突（HTTP 409）：对象可能已被他人修改。`,
          { status: 409, facts: { url: response.url, body: redact(response.json) } })
      }
      if (response.status === 405) {
        return new ZenTaoError(CODES.UNSUPPORTED,
          `${what}的方法不被禅道接受（HTTP 405）。该写操作的路径/方法可能尚未实测校准，请运行 /zentao doctor 查看。`,
          { status: 405, facts: { url: response.url, method: response.method } })
      }
      return new ZenTaoError(codeForStatus(response.status),
        `${what}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
        { status: response.status, facts: { url: response.url, contentType: response.contentType } })
    },

    /**
     * 检测"HTTP 200 但业务失败"。
     * [文档] 删除类响应用 `{"message":"success"}`；旧版 SDK 响应用 `{"status":1,"msg":"success","result":[]}`，
     * 失败时 `status: 0`。注意：**实体**载荷里也有 `status` 字段（值是 'doing'/'done' 这类字符串），
     * 因此这里只把**数值 0** 当作失败，绝不把字符串状态误判成错误。
     */
    detectBusinessError (json) {
      if (json === null || typeof json !== 'object') return undefined
      if (typeof json.error === 'string' && json.error.trim() !== '') return json.error.trim()
      if (json.error === true) return '禅道返回了 error=true'
      if (json.status === 0 || json.status === '0') {
        const msg = typeof json.msg === 'string' && json.msg.trim() !== '' ? json.msg.trim() : 'status=0'
        return `禅道返回失败：${msg}`
      }
      if (typeof json.result === 'string' && /^(fail|failed|error)$/i.test(json.result)) {
        return `禅道返回 result=${json.result}`
      }
      return undefined
    },

    /** [推断] 网页深链形态 `<base>/<entity>-view-<id>.html`。 */
    webLink (baseUrl, entity, id) {
      if (!baseUrl) return undefined
      const spec = entityOf(entity)
      return `${baseUrl.replace(/\/+$/, '')}/${spec.webPath(id)}`
    },
  }
}

export { BASE_PATH as REST_V1_BASE_PATH, WRITE_BUILDERS as REST_V1_WRITE_BUILDERS }
