/**
 * 归一化与查询的离线测试。
 * 重点是 design §7.4 那张「实证陷阱」表的每一条都必须有断言 —— 这些坑是真机上
 * 会静默出错的地方，而它们全都可以离线复现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cleanDate, excerpt, normalizeItem, pickArray, pickPageMeta, pickUser, stripHtml, toId, toStatusCode, unwrapItem,
} from '../src/domain/normalize.js'
import {
  applyProjection, filterItems, normalizeFilters, normalizeOrderBy, paginateLocally, sortItems,
} from '../src/domain/query.js'
import { rawTask } from './helpers.js'

test('id 一律转字符串（避免数字精度与"模型做算术"）', () => {
  assert.equal(toId(18), '18')
  assert.equal(toId('18'), '18')
  assert.equal(toId(0), '0')
  assert.equal(toId(null), undefined)
  assert.equal(toId(''), undefined)
})

test('陷阱：0000-00-00 与 null 都必须视为缺失，而不是有效日期', () => {
  assert.equal(cleanDate('0000-00-00'), undefined)
  assert.equal(cleanDate('0000-00-00 00:00:00'), undefined)
  assert.equal(cleanDate('0000-00-00T00:00:00Z'), undefined)
  assert.equal(cleanDate(null), undefined)
  assert.equal(cleanDate(''), undefined)
  assert.equal(cleanDate('0'), undefined)
  assert.equal(cleanDate(undefined), undefined)
})

test('陷阱：UTC ISO-8601 原样透传，不被改成本地时间', () => {
  assert.equal(cleanDate('2021-11-29T02:33:47Z'), '2021-11-29T02:33:47Z')
  // 纯日期保留
  assert.equal(cleanDate('2021-12-31'), '2021-12-31')
  // legacy 的本地时间串只做 T 分隔规范化，不伪造时区
  assert.equal(cleanDate('2021-12-31 08:00:00'), '2021-12-31T08:00:00')
})

test('真实形状：Bug 详情的字段（本机禅道实测，逐条钉住）', () => {
  const raw = {
    id: '1', product: 1, project: 0, execution: 0, story: 0, task: 0, module: 0,
    title: '校准用 Bug', status: 'active', pri: 2, severity: 2, type: 'codeerror',
    assignedTo: '', // 未指派是**空字符串**，不是 null
    openedBy: { id: '2', account: 'admin', avatar: '', realname: 'admin' },
    openedDate: '2026-09-30T14:04:56Z', // UTC ISO
    resolution: '', deadline: '', lastEditedDate: '',
    steps: '打开页面即白屏', openedBuild: [],
  }
  const item = normalizeItem('bug', raw)
  assert.equal(item.ref.id, '1', 'id 是字符串')
  assert.equal(item.statusCode, 'active')
  assert.equal(item.priority, 2)
  assert.deepEqual(item.product, { entity: 'product', id: '1' }, '数字 id 要字符串化')
  assert.equal(item.project, undefined, '0 表示"无"，不能变成 {id:"0"}')
  assert.equal(item.execution, undefined)
  assert.equal(item.story, undefined)
  assert.equal(item.assignee, undefined, '空字符串的指派人是"未指派"，不能变成用户对象')
  assert.deepEqual(item.openedBy, { id: '2', name: 'admin', account: 'admin' })
  assert.equal(item.createdAt, '2026-09-30T14:04:56Z')
  assert.equal(item.dueDate, undefined, '空字符串日期是"无"')
  assert.equal(item.version, undefined, '本版本 Bug 详情没有 version 字段（并发校验会因此退化为回读比对）')
})

test('陷阱：真实禅道 GET /user 把当前用户包在 profile 键里（实测校准）', () => {
  const raw = { profile: { id: '2', account: 'admin', realname: 'admin', company: '0' } }
  const item = unwrapItem(raw, 'user', 'users')
  assert.equal(item.id, '2')
  assert.equal(item.account, 'admin')
})

test('unwrapItem：profile 只作为**最后**的候选，不会抢先去解包别的实体', () => {
  // 任务详情里万一也有 profile 键，仍应优先按 tasks/task/data 解包
  const raw = { tasks: { id: '18', name: '任务' }, profile: { id: '9' } }
  assert.equal(unwrapItem(raw, 'task', 'tasks').id, '18')
})

test('陷阱：用户字段既嵌套又扁平 → 优先嵌套对象，取 realname ?? account', () => {
  assert.deepEqual(pickUser({ id: 1, account: 'admin', realname: 'administrator' }), { id: '1', name: 'administrator', account: 'admin' })
  assert.deepEqual(pickUser({ id: 2, account: 'dev' }), { id: '2', name: 'dev', account: 'dev' })
  assert.deepEqual(pickUser('张三'), { name: '张三' })
  assert.equal(pickUser(0), undefined)
  assert.equal(pickUser(''), undefined)
})

test('陷阱：状态代码原样保留，标签只用于展示，未命中不猜', () => {
  assert.equal(toStatusCode('Done'), 'done')
  assert.equal(toStatusCode('In Progress'), 'in-progress')
  const known = normalizeItem('task', rawTask({ status: 'done' }))
  assert.equal(known.statusCode, 'done')
  assert.match(known.statusLabel, /已完成/)
  const unknown = normalizeItem('task', rawTask({ status: 'weird-state' }))
  assert.equal(unknown.statusCode, 'weird-state')
  assert.equal(unknown.statusLabel, 'weird-state') // 原样回显，不猜
})

test('normalizeItem 走通真实任务载荷（含截止日为 null、估算为 0）', () => {
  const item = normalizeItem('task', rawTask(), { webLink: (entity, id) => `https://zt/${entity}-view-${id}.html` })
  assert.equal(item.ref.id, '18')
  assert.equal(item.ref.entity, 'task')
  assert.equal(item.title, 'task1')
  assert.equal(item.assignee.name, 'administrator')
  assert.equal(item.openedBy.name, 'administrator')
  assert.equal(item.createdAt, '2021-11-29T02:33:47Z')
  assert.equal(item.dueDate, undefined)          // null → 缺失
  assert.equal(item.estimate, 0)                  // 0 是有效数字，不能当成缺失
  assert.equal(item.progress, 100)
  assert.equal(item.version, 1)                   // 乐观并发校验要用
  assert.equal(item.execution.id, '13')
  assert.equal(item.parent, undefined)            // parent=0 → 不算父项
  assert.equal(item.url, 'https://zt/task-view-18.html')
  assert.equal(item.excerpt, 'hello world')       // 富文本默认剥掉
})

test('富文本剥标签（正文是不可信数据，只留文本）', () => {
  assert.equal(stripHtml('<p>a<script>evil()</script><b>b</b></p>'), 'a b')
  assert.equal(stripHtml('<style>x{}</style>t'), 't')
  assert.equal(excerpt('<p>' + 'x'.repeat(500) + '</p>', { max: 10 }), `${'x'.repeat(10)}…（已截断）`)
  assert.equal(excerpt('   ', {}), undefined)
})

test('pickArray 容错：先按声明的复数键，再退到第一个数组值', () => {
  assert.deepEqual(pickArray({ total: 1, products: [1, 2] }, 'products'), [1, 2])
  assert.deepEqual(pickArray({ total: 1, weirdKey: [3] }, 'products'), [3])
  assert.deepEqual(pickArray({ total: 0 }, 'products'), [])
  assert.deepEqual(pickArray([9], 'x'), [9])
})

test('pickPageMeta 读响应侧的分页元数据（已核验的字段）', () => {
  assert.deepEqual(pickPageMeta({ page: 2, total: 7, limit: 100 }, { page: 1 }), { page: 2, total: 7, limit: 100 })
  assert.deepEqual(pickPageMeta(null, { page: 1, total: undefined, limit: 50 }), { page: 1, total: undefined, limit: 50 })
})

test('过滤：状态用原始代码，指派人支持姓名/账号/部分匹配', () => {
  const items = [
    normalizeItem('task', rawTask({ id: 1, status: 'done', assignedTo: { id: 1, account: 'admin', realname: '张三' } })),
    normalizeItem('task', rawTask({ id: 2, status: 'doing', assignedTo: { id: 2, account: 'dev', realname: '李四' } })),
    normalizeItem('task', rawTask({ id: 3, status: 'wait', assignedTo: null })),
  ]
  assert.equal(filterItems(items, { status: ['done'] }, '2026-03-01').length, 1)
  assert.equal(filterItems(items, { assignee: '李四' }, '2026-03-01').length, 1)
  assert.equal(filterItems(items, { assignee: 'ad' }, '2026-03-01').length, 1)
  assert.equal(filterItems(items, { assignee: 'nobody' }, '2026-03-01').length, 0)
  assert.equal(filterItems(items, {}, '2026-03-01').length, 3)
})

test('过滤：逾期只看未完成，且没有截止日的不算逾期', () => {
  const items = [
    normalizeItem('task', rawTask({ id: 1, status: 'doing', deadline: '2026-01-01' })),
    normalizeItem('task', rawTask({ id: 2, status: 'done', deadline: '2026-01-01' })),
    normalizeItem('task', rawTask({ id: 3, status: 'wait', deadline: null })),
  ]
  const overdue = filterItems(items, { overdue: true }, '2026-03-01')
  assert.deepEqual(overdue.map((item) => item.ref.id), ['1'])
})

test('过滤：关键字命中标题与正文，未知过滤键直接报错并列出可用项', () => {
  const items = [normalizeItem('task', rawTask({ name: '登录页白屏' }))]
  assert.equal(filterItems(items, { keyword: '白屏' }, '2026-03-01').length, 1)
  assert.equal(filterItems(items, { keyword: 'zzz' }, '2026-03-01').length, 0)
  assert.throws(() => normalizeFilters({ nope: 1 }), /不认识的键.*nope/)
})

test('排序：null 排在后面（不要让"没有截止日"占首屏）', () => {
  const items = [
    normalizeItem('task', rawTask({ id: 1, deadline: null })),
    normalizeItem('task', rawTask({ id: 2, deadline: '2026-05-01' })),
    normalizeItem('task', rawTask({ id: 3, deadline: '2026-01-01' })),
  ]
  assert.deepEqual(sortItems(items, 'due_asc').map((item) => item.ref.id), ['3', '2', '1'])
  assert.equal(normalizeOrderBy(undefined), 'updated_desc')
  assert.throws(() => normalizeOrderBy('nope'), /不认识的 orderBy/)
})

test('陷阱：assignedTo 显式为 null 表示"未指派"，不得回落到扁平字段', () => {
  // 真实载荷里同时存在 assignedTo 与 assignedToRealName；前者为 null 时含义是未指派
  const unassigned = normalizeItem('task', rawTask({ assignedTo: null }))
  assert.equal(unassigned.assignee, undefined)
  // 嵌套键缺失时才看扁平字段
  const flatOnly = rawTask()
  delete flatOnly.assignedTo
  assert.equal(normalizeItem('task', flatOnly).assignee.name, 'administrator')
})

test('投影与本地分页', () => {
  const items = [1, 2, 3, 4, 5].map((n) => normalizeItem('task', rawTask({ id: n }), {
    webLink: (entity, id) => `https://zt/${entity}-view-${id}.html`,
  }))
  const projected = applyProjection(items, ['assignee'])
  assert.deepEqual(Object.keys(projected[0]).sort(), ['assignee', 'ref', 'statusCode', 'statusLabel', 'title', 'url'])
  const paged = paginateLocally(items, 2, 2)
  assert.deepEqual(paged.items.map((item) => item.ref.id), ['3', '4'])
  assert.equal(paged.totalMatched, 5)
  assert.equal(paged.hasMore, true)
})
