/**
 * L4 工具层：把 `ctx.zentao` 的用例暴露给模型。
 *
 * 约定（design §8）：
 *   - 工具 `name` 与 `enum` **取值**保持 ASCII（机器标识符），
 *     所有 `description`、参数说明、结果文本一律中文（D3）；
 *   - 结果统一为 `{ text }`，`output.render` 取出文本 —— 模型看到的就是它；
 *   - 工具失败**不结束本轮**：错误被收敛成文本结果返回。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { ENTITY_KEYS, WRITE_ACTION_KEYS, writeActionOf, entityOf } from './domain/model.js'
import { FILTER_KEYS, ORDER_KEYS } from './domain/query.js'
import { renderBoard, renderItem, renderList, renderLine, renderPlan, renderWriteResult } from './domain/render.js'
import { errorText } from './guard.js'

/** 所有工具共用的输出契约：只有一段文本。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const SCOPE_PROP = {
  type: 'object',
  additionalProperties: false,
  description: '限定查询范围。禅道 v1 的端点形态要求：任务必须给 execution，Bug 必须给 product，' +
    '需求可给 product / project / execution 之一，执行必须给 project。',
  properties: {
    product: { type: 'string', description: '产品 id' },
    project: { type: 'string', description: '项目 id' },
    execution: { type: 'string', description: '执行（迭代）id' },
  },
}

const FILTERS_PROP = {
  type: 'object',
  additionalProperties: false,
  description: '过滤条件。**在插件本地过滤**（禅道 v1 的请求侧过滤参数名未经实测，故不下推到服务端），' +
    '因此扫描有页数上限；触上限时结果会标注"不完整"。',
  properties: {
    status: { type: 'array', items: { type: 'string' }, description: '状态**原始代码**（如 wait/doing/done/closed/active/resolved），不是中文标签' },
    assignee: { type: 'string', description: '指派给：禅道账号名或姓名（部分匹配）' },
    openedBy: { type: 'string', description: '创建者：账号名或姓名（部分匹配）' },
    keyword: { type: 'string', description: '标题/正文/编号的关键字（不区分大小写）' },
    updatedSince: { type: 'string', description: '最后更新时间不早于该时刻，如 2026-03-01 或 2026-03-01T00:00:00Z' },
    dueBefore: { type: 'string', description: '截止日期不晚于该日期，如 2026-03-31' },
    priority: { type: 'array', items: { type: 'integer' }, description: '优先级数值（禅道 pri：1 最高，4 低）' },
    overdue: { type: 'boolean', description: '只看已逾期且未完成的' },
  },
}

/**
 * @param {object} ctx
 * @param {object} service        createService(...) 的返回值
 * @param {() => object} getConfig 配置快照
 * @returns {() => void} 为 nil（注册即生效，随 ctx 生命周期拆除）
 */
export function registerTools (ctx, service, getConfig) {
  /* ── 1. zentao_query ───────────────────────────────── */
  ctx.tools.register(defineTool({
    name: 'zentao_query',
    description:
      '查询禅道的实体列表（产品、项目、执行/迭代、需求、任务、Bug、用户、计划、发布、版本、用例、测试单）。' +
      '只读。注意禅道 v1 的端点形态：任务必须用 scope.execution 指定执行，Bug 必须用 scope.product 指定产品。' +
      '返回每条目的编号、标题、状态、指派人与禅道网页链接。',
    parameters: {
      entity: {
        type: 'string',
        required: true,
        enum: [...ENTITY_KEYS],
        description: '要查询的实体。product=产品，project=项目，execution=执行(迭代)，story=需求，task=任务，bug=Bug',
      },
      scope: SCOPE_PROP,
      filters: FILTERS_PROP,
      orderBy: { type: 'string', enum: [...ORDER_KEYS], description: '排序，默认 updated_desc（最近更新的在前）' },
      page: { type: 'integer', description: '页码，从 1 开始（默认 1）' },
      pageSize: { type: 'integer', description: '每页条数（默认取 maxResultItems，受 maxPageSize 硬上限约束）' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: '字段投影：只返回点名的字段（外加 ref/title/statusLabel/url），用于省 token',
      },
    },
    output: TEXT_OUTPUT,
    async execute (args, exec) {
      try {
        const result = await service.query({
          entity: args.entity,
          scope: args.scope,
          filters: args.filters,
          orderBy: args.orderBy,
          page: args.page ?? 1,
          pageSize: args.pageSize,
          fields: args.fields,
          signal: exec.signal,
        })
        let text = renderList({
          entityLabel: result.entityLabel,
          items: result.items,
          total: result.matchedTotal,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
          partial: result.partial,
          partialNote: result.partialNote,
          shapeNote: result.shapeNote,
          siteLabel: result.siteLabel,
        })
        if (getConfig().includeRawPayload) {
          text += `\n\n（调试）扫描 ${result.scanned} 条，服务端报告总数 ${result.serverTotal ?? '未知'}。`
          const sample = result.items.find((item) => item.raw)
          if (sample) {
            text += `\n（调试）首条原始载荷（已脱敏，用于校准字段名）：\n${JSON.stringify(sample.raw, null, 2)}`
          }
        }
        return { text }
      } catch (error) {
        return { text: errorText(error) }
      }
    },
  }))

  /* ── 2. zentao_get ─────────────────────────────────── */
  ctx.tools.register(defineTool({
    name: 'zentao_get',
    description:
      '读取禅道单个对象的详情（含指派、工时、归属与正文摘要），并返回它的版本号。' +
      '版本号请保留：写入时用 expectedVersion 传回，可避免覆盖别人的修改。只读。',
    parameters: {
      entity: { type: 'string', required: true, enum: [...ENTITY_KEYS], description: '实体类型' },
      id: { type: 'string', required: true, description: '对象编号' },
      expand: {
        type: 'array',
        items: { type: 'string', enum: ['parent', 'children', 'relations', 'history', 'comments', 'attachments', 'effort'] },
        description: '想额外展开的内容。注意：评论/历史/附件端点尚未实测校准，目前会被明确告知"没做"而不是返回空',
      },
    },
    output: TEXT_OUTPUT,
    async execute (args, exec) {
      try {
        const result = await service.get({ entity: args.entity, id: args.id, expand: args.expand, signal: exec.signal })
        let text = renderItem(result.item, { entityLabel: result.entityLabel })
        if (result.notes.length > 0) text += `\n\n${result.notes.map((note) => `说明：${note}`).join('\n')}`
        return { text }
      } catch (error) {
        return { text: errorText(error) }
      }
    },
  }))

  /* ── 3. zentao_my ──────────────────────────────────── */
  ctx.tools.register(defineTool({
    name: 'zentao_my',
    description:
      '汇总"我的"禅道工作：指派给我的任务与 Bug（可按逾期/今日到期过滤）。只读。' +
      '注意：禅道 v1 **没有**"我的待办"聚合端点，本工具由插件在多个执行与产品间逐个扫描后本地匹配，' +
      '因此有扫描上限；触上限时结果会明确标注扫描范围，不要据此判断总量。',
    parameters: {
      scope: {
        type: 'string',
        enum: ['assigned', 'opened', 'today'],
        description: 'assigned=指派给我（默认），opened=我创建的，today=今天到期',
      },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['task', 'bug', 'story', 'todo', 'effort'] },
        description: '要包含的类别，默认 task + bug。story/todo/effort 目前未实现（会明确说明）',
      },
      dueWithin: { type: 'string', description: '到期窗口：today / overdue / 7d（数字+天）' },
    },
    output: TEXT_OUTPUT,
    async execute (args, exec) {
      try {
        const result = await service.my({
          scope: args.scope,
          include: args.include,
          dueWithin: args.dueWithin,
          signal: exec.signal,
        })
        const lines = [
          `禅道 · ${result.siteLabel} · 我的工作（当前账号：${result.user}）`,
          `按${result.scope === 'opened' ? '创建人' : '指派人'}精确匹配：${(result.matchedBy ?? []).join(' / ')}`,
        ]
        let index = 0
        for (const group of result.groups) {
          const label = entityOf(group.entity).label
          lines.push('', `── ${label}（匹配 ${group.items.length} 条）──`)
          if (group.items.length === 0) {
            lines.push('  （无）')
            continue
          }
          for (const item of group.items.slice(0, getConfig().maxResultItems)) {
            lines.push(renderLine(item, index))
            index += 1
          }
          if (group.items.length > getConfig().maxResultItems) {
            lines.push(`  … 还有 ${group.items.length - getConfig().maxResultItems} 条`)
          }
        }
        if (result.partial) {
          lines.push('', '⚠️ 扫描达到上限，结果**不完整**，不要据此判断"没有更多"。')
        }
        if (result.notes.length > 0) {
          lines.push('', ...result.notes.map((note) => `说明：${note}`))
        }
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: errorText(error) }
      }
    },
  }))

  /* ── 4. zentao_write ───────────────────────────────── */
  ctx.tools.register(defineTool({
    name: 'zentao_write',
    description:
      '对禅道做受控写入。**默认 dryRun=true，只回显将要发出的请求，不落库**；' +
      '确认无误后再用相同参数把 dryRun 设为 false 调用一次。是否需要用户确认由设置页的写入策略决定。\n' +
      '各 action 的 payload 字段（都是禅道原始字段名）：\n' +
      '· create：task 用 name/type/assignedTo(数组)/pri/estimate/**estStarted（实测必填）**/deadline（须给 execution）；' +
      'bug 用 title/severity/pri/type/steps/openedBuild（须给 product）；' +
      'story 用 title/product/pri/category/**spec（描述，实测必填）**/verify（产品开启评审时还要 reviewer，且 **reviewer 必须传数组**）。\n' +
      '· update：task 可改 module/story/fromBug/name/type/assignedTo/pri/estimate/estStarted/deadline；' +
      'bug 可改 title/keywords/severity/pri/type/os/browser/steps/deadline/module/execution；' +
      'story 只可改 title/spec/verify。**注意 task 与 bug 都没有 status 字段** —— 改状态请用 start/finish（任务）或 resolve/close（Bug）。\n' +
      '· start：left 必填（剩余工时），可选 assignedTo/realStarted/consumed/comment。\n' +
      '· finish：currentConsumed 与 finishedDate 必填，可选 assignedTo/realStarted/comment。\n' +
      '· assign：assignee/assignedTo（禅道账号名）。**任务必须同时给 left（预计剩余工时）** —— 实测缺它会报「『预计剩余』不能为空」；可选 comment。\n' +
      '· comment：comment（文本）。⚠️ 实测该动作在本版本**没有可用的 REST 形状**，默认会被闸门拦住。\n' +
      '· resolve（仅 bug）：resolution 必填（fixed/notrepro/duplicateBug/bydesign/willnotfix/postponed/external），可选 resolvedBuild/comment/assignedTo。\n' +
      '· close：**必须给顶层 reason**（它会被作为备注写入禅道，避免无声变更）；**关闭需求时还要 payload.closedReason**（如 done/willnotdo/duplicate/postpone）；可选 comment。\n' +
      '· delete：无 payload。\n' +
      '· log_effort：consumed 必填（本次消耗工时），可选 date/work/left（Bug 用 dates 而不是 date，且没有 left）。',
    parameters: {
      action: { type: 'string', required: true, enum: [...WRITE_ACTION_KEYS], description: '要执行的写操作' },
      entity: {
        type: 'string',
        required: true,
        enum: ['story', 'task', 'bug'],
        description: '目标实体（写操作只支持需求/任务/Bug）',
      },
      id: { type: 'string', description: '目标编号。除 create 外必填' },
      payload: { type: 'json', description: '写操作字段，见工具描述里的逐条说明' },
      scope: SCOPE_PROP,
      reason: { type: 'string', description: '关闭/解决类操作必填，会作为备注（comment）写入禅道，避免"无声变更"' },
      expectedVersion: {
        type: 'string',
        description: '并发基线：传此前用 zentao_get 读到的 **updatedAt**（实测本机 PUT 不递增 version，时间戳才有效）。'
          + '对象自你读取后被改过时会返回 CONFLICT 且不写入（不会覆盖他人修改）。'
          + '注意禅道时间戳是秒级精度，同一秒内的多次编辑无法区分。',
      },
      dryRun: { type: 'boolean', description: '默认 true（只回显请求）。确认后设为 false 才真正写入' },
      bulk: { type: 'json', description: '批量项数组，形如 [{id, payload}]。需在设置页开启 allowBulkWrite' },
    },
    output: TEXT_OUTPUT,
    async execute (args, exec) {
      try {
        const result = await service.write({
          action: args.action,
          entity: args.entity,
          id: args.id,
          payload: args.payload ?? {},
          scope: args.scope,
          reason: args.reason,
          expectedVersion: args.expectedVersion,
          dryRun: args.dryRun !== false,
          bulk: args.bulk,
          signal: exec.signal,
        })
        if (result.dryRun) {
          return {
            text: renderPlan({
              actionLabel: result.actionLabel,
              entityLabel: result.entityLabel,
              steps: result.steps,
              verified: result.verified,
              notes: result.notes,
            }),
          }
        }
        return {
          text: renderWriteResult({
            actionLabel: result.actionLabel,
            results: result.results,
            idempotent: result.idempotent,
          }),
        }
      } catch (error) {
        return { text: errorText(error) }
      }
    },
  }))

  /* ── 5. zentao_board ───────────────────────────────── */
  ctx.tools.register(defineTool({
    name: 'zentao_board',
    description:
      '一次拿到一个执行/项目/产品的看板视图：各分组的状态计数，加上阻塞(逾期未完成)项与高优先级项。' +
      '只读。各范围能取到的分组不同（由禅道端点形态决定）：执行范围取需求/任务/Bug；' +
      '项目范围取需求/执行/任务（任务分散在各执行里，只覆盖前若干个执行并会明确说明）；' +
      '产品范围取需求/Bug。取不到的会说明原因，不会悄悄少给。',
    parameters: {
      scope: { type: 'string', required: true, enum: ['execution', 'project', 'product'], description: '看板范围类型' },
      id: { type: 'string', required: true, description: '范围对象编号' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['stories', 'tasks', 'bugs', 'executions'] },
        description: '要包含的分组。不填时：执行范围默认 stories+tasks+bugs，项目范围默认 stories+executions+tasks（项目范围取不到 Bug）',
      },
    },
    output: TEXT_OUTPUT,
    async execute (args, exec) {
      try {
        const result = await service.board({
          scope: args.scope,
          id: args.id,
          include: args.include,
          signal: exec.signal,
        })
        return {
          text: renderBoard({
            scopeLabel: result.scopeLabel,
            counts: result.counts,
            blockers: result.blockers,
            topItems: result.topItems,
            note: result.note,
          }),
        }
      } catch (error) {
        return { text: errorText(error) }
      }
    },
  }))
}

/** 供命令层复用：把 action 的说明摊平（`/zentao help` 用）。 */
export function describeWriteActions () {
  return WRITE_ACTION_KEYS.map((key) => {
    const spec = writeActionOf(key)
    return `${key}（${spec.label}）：支持 ${spec.entities.map((e) => entityOf(e).label).join('、')}`
  }).join('\n')
}
