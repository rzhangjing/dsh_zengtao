/**
 * 归一化领域模型：实体语义、写操作契约、状态/优先级的**展示**映射。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 * 设计依据：design/02-detailed-design.md §5、§8.4。
 *
 * ⚠️ 标注「待实测校准」的映射表只用于**展示**，绝不参与正确性判断：
 *    - 过滤/匹配一律使用**线上返回的原始状态码**（见 normalize.js 的 statusCode）；
 *    - 因此即使某个中文标签猜错，也只会显示得不好看，不会让模型做出错误推理。
 *    这一点是 §7.4「文档状态值与真实载荷不一致」那条实证的直接对策。
 */

/**
 * 实体表。`scope` 列出一个实体在禅道 v1 里**必须**提供的限定范围键
 * （端点形态所限：任务挂在执行下、Bug 挂在产品下，见 §7.3）。
 */
export const ENTITIES = Object.freeze({
  product: {
    key: 'product', label: '产品', plural: 'products',
    scope: [], scopeOptional: true,
    webPath: (id) => `product-view-${id}.html`,
  },
  project: {
    key: 'project', label: '项目', plural: 'projects',
    scope: [], scopeOptional: true,
    webPath: (id) => `project-view-${id}.html`,
  },
  program: {
    key: 'program', label: '项目集', plural: 'programs',
    scope: [], scopeOptional: true,
    webPath: (id) => `program-view-${id}.html`,
  },
  execution: {
    key: 'execution', label: '执行（迭代）', plural: 'executions',
    scope: ['project'], scopeOptional: false,
    webPath: (id) => `execution-view-${id}.html`,
  },
  story: {
    key: 'story', label: '需求', plural: 'stories',
    scope: ['product', 'project', 'execution'], scopeOptional: false,
    webPath: (id) => `story-view-${id}.html`,
  },
  task: {
    key: 'task', label: '任务', plural: 'tasks',
    scope: ['execution'], scopeOptional: false,
    webPath: (id) => `task-view-${id}.html`,
  },
  bug: {
    key: 'bug', label: 'Bug', plural: 'bugs',
    scope: ['product'], scopeOptional: false,
    webPath: (id) => `bug-view-${id}.html`,
  },
  user: {
    key: 'user', label: '用户', plural: 'users',
    scope: [], scopeOptional: true,
    webPath: (id) => `user-view-${id}.html`,
  },
  plan: {
    key: 'plan', label: '产品计划', plural: 'plans',
    scope: ['product'], scopeOptional: false,
    // 实测校准：禅道**没有** `plan` 这个模块（`module/plan` 不存在，`plan-view-1.html`
  // 返回 200 = 路由不被识别）。产品计划的模块名是 `productplan`（数据库表 `zt_productplan`，
  // 且 IPD 扩展目录里也只有 productplan/programplan/researchplan/trainplan）。
  webPath: (id) => `productplan-view-${id}.html`,
  },
  release: {
    key: 'release', label: '发布', plural: 'releases',
    scope: ['product', 'project'], scopeOptional: false,
    webPath: (id) => `release-view-${id}.html`,
  },
  build: {
    key: 'build', label: '版本（构建）', plural: 'builds',
    scope: ['project', 'execution'], scopeOptional: false,
    webPath: (id) => `build-view-${id}.html`,
  },
  testcase: {
    key: 'testcase', label: '测试用例', plural: 'testcases',
    scope: ['product'], scopeOptional: false,
    webPath: (id) => `testcase-view-${id}.html`,
  },
  testtask: {
    key: 'testtask', label: '测试单', plural: 'testtasks',
    scope: [], scopeOptional: true,
    webPath: (id) => `testtask-view-${id}.html`,
  },
  // ── 企业版自带（D1）；按能力探测决定是否暴露 ──
  feedback: {
    key: 'feedback', label: '反馈', plural: 'feedbacks',
    scope: [], scopeOptional: true, enterprise: true,
    webPath: (id) => `feedback-view-${id}.html`,
  },
  ticket: {
    key: 'ticket', label: '工单', plural: 'tickets',
    scope: [], scopeOptional: true, enterprise: true,
    webPath: (id) => `ticket-view-${id}.html`,
  },
})

/** 工具 `enum` 用的实体取值（ASCII，顺序即展示顺序）。 */
export const ENTITY_KEYS = Object.freeze([
  'product', 'project', 'program', 'execution', 'story', 'task', 'bug',
  'user', 'plan', 'release', 'build', 'testcase', 'testtask',
])

/** 企业版附加实体（单独列出，便于按探测结果决定是否并入 enum）。 */
export const ENTERPRISE_ENTITY_KEYS = Object.freeze(['feedback', 'ticket'])

export function entityOf (key) {
  const spec = ENTITIES[key]
  if (!spec) {
    const known = [...ENTITY_KEYS, ...ENTERPRISE_ENTITY_KEYS].join('、')
    throw new Error(`未知实体 "${key}"。可用实体：${known}`)
  }
  return spec
}

/* ─────────────────── 状态与优先级的展示映射 ─────────────────── */

/**
 * ⚠️ 待实测校准（presentation-only）。
 * 禅道**文档表格**给的是人类标签，而**线上载荷**给的是内部代码 —— 二者不一致
 * （实证：任务文档写 `Completed`，真实响应是 `"status": "done"`）。
 * 因此这里只做"内部代码 → 中文"的展示翻译，匹配与过滤一律用原始代码。
 */
export const STATUS_LABELS = Object.freeze({
  task: { wait: '未开始', doing: '进行中', done: '已完成', closed: '已关闭', cancel: '已取消', pause: '已暂停' },
  bug: { active: '激活', resolved: '已解决', closed: '已关闭' },
  story: { draft: '草稿', reviewing: '评审中', active: '激活', closed: '已关闭', changed: '已变更' },
  execution: { wait: '未开始', doing: '进行中', suspended: '已挂起', closed: '已关闭' },
  project: { wait: '未开始', doing: '进行中', suspended: '已挂起', closed: '已关闭' },
  plan: { wait: '未开始', doing: '进行中', closed: '已关闭' },
  build: { normal: '正常' },
  testcase: { wait: '未执行', doing: '执行中', done: '已通过', blocked: '受阻' },
  testtask: { wait: '未开始', doing: '进行中', done: '已完成', blocked: '受阻' },
})

/** ⚠️ 待实测校准（presentation-only）：禅道 pri 1..4。 */
export const PRIORITY_LABELS = Object.freeze({ 1: '最高', 2: '高', 3: '中', 4: '低' })

/** 未命中就原样回显内部代码 —— 绝不猜，也绝不显示空白。 */
export function labelForStatus (entity, rawStatus) {
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') return '（无状态）'
  const table = STATUS_LABELS[entity]
  const key = String(rawStatus).trim().toLowerCase()
  const label = table?.[key]
  return label ? `${label}（${rawStatus}）` : String(rawStatus)
}

export function labelForPriority (pri) {
  if (pri === undefined || pri === null || pri === '') return ''
  const label = PRIORITY_LABELS[String(pri)]
  return label ? `${label}(P${pri})` : `P${pri}`
}

/* ─────────────────────────── 写操作契约 ─────────────────────────── */

/**
 * 写操作表。
 * - `entities` 明确列出该操作支持的实体（手册只确认了这些组合）。
 * - `destructive` 的操作**不受 writePolicy 放宽**，永远需要用户确认（§9.1）。
 * - `reasonRequired` 的操作必须有 reason，避免"无声变更"。
 *
 * ⚠️ 动作式端点（start/finish/change）单列成独立 action，而不是伪装成 `update`：
 * 手册明文确认 `PUT /tasks/:id` 与 `PUT /bugs/:id` 的字段表里**没有 status**，
 * 把"改状态"做成 update 会静默失败。
 */
export const WRITE_ACTIONS = Object.freeze({
  create: { label: '新建', entities: ['story', 'task', 'bug'], requiresId: false, payloadRequired: true },
  update: { label: '修改', entities: ['story', 'task', 'bug'], requiresId: true, payloadRequired: true },
  start: { label: '开始任务', entities: ['task'], requiresId: true },
  finish: { label: '完成任务', entities: ['task'], requiresId: true },
  assign: { label: '指派', entities: ['story', 'task', 'bug'], requiresId: true },
  comment: { label: '添加备注', entities: ['story', 'task', 'bug'], requiresId: true },
  resolve: { label: '解决 Bug', entities: ['bug'], requiresId: true },
  close: { label: '关闭', entities: ['story', 'task', 'bug'], requiresId: true, reasonRequired: true },
  delete: { label: '删除', entities: ['story', 'task', 'bug'], requiresId: true, destructive: true },
  log_effort: { label: '登记工时', entities: ['task', 'bug', 'story'], requiresId: true },
})

export const WRITE_ACTION_KEYS = Object.freeze(Object.keys(WRITE_ACTIONS))

export function writeActionOf (key) {
  const spec = WRITE_ACTIONS[key]
  if (!spec) {
    throw new Error(`未知写操作 "${key}"。可用操作：${WRITE_ACTION_KEYS.join('、')}`)
  }
  return spec
}

/* ──── 已文档化的请求体字段（全部逐字取自官方手册，不是猜的）──── */

/** [文档] POST /executions/:id/tasks */
export const TASK_CREATE_FIELDS = Object.freeze([
  'module', 'story', 'fromBug', 'name', 'type', 'assignedTo', 'pri', 'estimate',
  'estStarted', 'deadline', 'openedBy', 'openedDate',
])

/** [文档] PUT /tasks/:id —— 全部可选；**注意没有 status** */
export const TASK_UPDATE_FIELDS = Object.freeze([
  'module', 'story', 'fromBug', 'name', 'type', 'assignedTo', 'pri', 'estimate',
  'estStarted', 'deadline',
])

/** [文档] POST /tasks/:id/start —— left 必填 */
export const TASK_START_FIELDS = Object.freeze(['assignedTo', 'realStarted', 'consumed', 'left', 'comment'])

/** [文档] POST /tasks/:id/finish —— currentConsumed 与 finishedDate 必填 */
export const TASK_FINISH_FIELDS = Object.freeze([
  'assignedTo', 'currentConsumed', 'realStarted', 'finishedDate', 'comment',
])

/** 实测（api/v1/entries/taskrecordestimate.php）：字段就是 date, consumed, left, work ——
 *  之前按 `hours` 猜的字段名是错的（端点路径也猜错了，见 rest-v1.js 的 log_effort）。 */
export const TASK_EFFORT_FIELDS = Object.freeze(['date', 'consumed', 'left', 'work'])

/** 实测（api/v1/entries/bugrecordestimate.php）：Bug 工时的字段是 dates, consumed, work（**没有 left**） */
export const BUG_EFFORT_FIELDS = Object.freeze(['dates', 'consumed', 'work'])

/** 实测：POST /tasks/:id/assignto（api/v1/entries/taskassignto.php）——assignedTo 必填 */
export const TASK_ASSIGN_FIELDS = Object.freeze(['assignedTo', 'comment', 'left'])

/** 实测：POST /bugs/:id/assign（api/v1/entries/bugassign.php）——assignedTo 必填 */
export const BUG_ASSIGN_FIELDS = Object.freeze(['assignedTo', 'mailto', 'comment'])

/** 实测：POST /stories/:id/close（api/v1/entries/storyclose.php）——closedReason 必填 */
export const STORY_CLOSE_FIELDS = Object.freeze(['closedReason', 'duplicateStory', 'comment'])

/** [文档] POST /products/:id/bugs */
export const BUG_CREATE_FIELDS = Object.freeze([
  'branch', 'module', 'execution', 'title', 'keywords', 'severity', 'pri', 'type',
  'os', 'browser', 'steps', 'task', 'story', 'deadline', 'openedBuild',
])

/** [文档] PUT /bugs/:id —— 字段表与创建相同；**注意没有 status** */
export const BUG_UPDATE_FIELDS = BUG_CREATE_FIELDS

/**
 * [文档] POST /stories —— title/product/pri/category 必填。
 * 实测补充：本机禅道（IPD 版）在产品开启评审时**还要求 `reviewer`**
 * （400 `{"error":{"reviewer":["『评审人』不能为空。"]}}`），因此把它加入可写字段，
 * 否则"新建需求"在该配置下无法完成。
 */
export const STORY_CREATE_FIELDS = Object.freeze([
  'title', 'product', 'pri', 'category', 'reviewer', 'spec', 'verify', 'source', 'sourceNote',
  'estimate', 'keywords',
])

/** [文档] POST /stories/:id/change —— 只有这三个字段 */
export const STORY_CHANGE_FIELDS = Object.freeze(['title', 'spec', 'verify'])

/** 按实体查「可写字段」——用于在**发出请求前**就拒绝非法字段。 */
export const WRITE_UPDATE_FIELDS = Object.freeze({
  task: TASK_UPDATE_FIELDS,
  bug: BUG_UPDATE_FIELDS,
  story: STORY_CHANGE_FIELDS,
})

export const WRITE_CREATE_FIELDS = Object.freeze({
  task: TASK_CREATE_FIELDS,
  bug: BUG_CREATE_FIELDS,
  story: STORY_CREATE_FIELDS,
})

/** [文档] 解决 Bug 的 resolution 取值。 */
export const BUG_RESOLUTIONS = Object.freeze([
  'bydesign', 'duplicateBug', 'external', 'fixed', 'notrepro', 'postponed', 'willnotfix',
])

/** [文档] 任务类型取值。 */
export const TASK_TYPES = Object.freeze([
  'design', 'devel', 'request', 'test', 'study', 'discuss', 'ui', 'affair', 'misc',
])
