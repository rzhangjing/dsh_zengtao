/**
 * 斜杠命令（`ctx.commands.register`）。
 *
 * 一个命令 `zentao` + 子命令，避免污染命令命名空间。
 * 命令 handler **直接执行、不产生模型消息**，返回 `{kind:'success'|'error', text}`；
 * 命令本身不做业务，只调 `ctx.zentao` 的同一个方法（"一个操作两个调用方"）。
 */

import { describeWriteActions } from './tools.js'
import { currentSessionId } from './projection.js'
import { CODES } from './domain/errors.js'
import { renderLine, renderSweep } from './domain/render.js'
import { accountRecordKey, describeAuth, passwordRecordKey } from './auth.js'

const USAGE = [
  '/zentao                —— 查看当前站点、方言、凭据、写入策略与缓存状态',
  '/zentao doctor         —— 重新探测并输出完整诊断事实表',
  '/zentao sweep          —— **只读**端点扫描：逐个实体发一次 GET，报告可用性、响应字段名与状态样本',
  '/zentao sweep <实体…>  —— 只扫指定实体，如 /zentao sweep task bug',
  '/zentao login          —— 交互式输入禅道**账号与密码**（密码不会出现在命令文本里），随后换取 Token 验证',
  '/zentao switch [产品编号或名称] [执行编号] —— 设置本会话的默认产品/执行；**不带参数会列出所有产品与编号**',
  '/zentao board <执行id>  —— 列出该执行的需求/任务/Bug 计数（打开看板请用 Web UI 侧栏的"禅道"）',
  '/zentao actions        —— 列出可用的写操作及其支持的实体',
  '/zentao help           —— 本帮助',
].join('\n')

export function registerCommands (ctx, service, getConfig, sessionContext, tokenSource) {
  const commands = ctx.get('commands')
  if (!commands) return undefined

  return commands.register({
    name: 'zentao',
    description: '禅道插件：状态、诊断、登录与会话上下文切换',
    input: { hint: '[doctor|login|switch|board|actions|help]' },
    async handler ({ agent, rawInput }) {
      const text = String(rawInput ?? '').trim()
      const [sub, ...rest] = text.split(/\s+/).filter(Boolean)
      const sessionId = agent?.session?.header?.id ?? agent?.session?.id ?? currentSessionId(ctx)

      try {
        switch (sub) {
          case undefined:
          case '': {
            const config = getConfig()
            const auth = await describeAuth(ctx, config)
            const mark = (info) => (info.configured
              ? `已配置（来源：${info.source ?? (info.record ? `凭据记录 ${info.record}` : '凭据库')}${info.writable === false ? '，只读' : ''}）`
              : '未配置')
            const lines = [
              '禅道插件状态',
              `站点名：${config.label}`,
              `baseURL：${config.baseURL || '（未配置 —— 请在设置页填写）'}`,
              `账号：${mark(auth.account)}`,
              `密码：${mark(auth.password)}`,
              `写入策略：${config.writePolicy}（批量写 ${config.allowBulkWrite ? '开' : '关'}）`,
              `详情缓存：${config.cacheTtlSeconds}s`,
              `会话上下文：${sessionContext.get(sessionId) ? `产品 ${sessionContext.get(sessionId).productId ?? '-'} / 执行 ${sessionContext.get(sessionId).executionId ?? '-'}` : '（未设置）'}`,
              '',
              '用 /zentao doctor 看完整诊断，/zentao help 看全部子命令。',
            ]
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'help':
            return { kind: 'success', text: USAGE }

          case 'actions':
            return { kind: 'success', text: `可用的写操作：\n${describeWriteActions()}` }

          case 'doctor': {
            const result = await service.doctor({})
            return { kind: result.ok ? 'success' : 'error', text: result.text }
          }

          case 'sweep': {
            // 只读扫描：rest 里可以点名实体，如 /zentao sweep task bug
            const result = await service.sweep({ include: rest.length > 0 ? rest : undefined })
            const failed = result.probes.filter((probe) => probe.ok !== true && probe.errorCode === undefined).length
            return { kind: failed > 0 ? 'error' : 'success', text: renderSweep(result) }
          }

          case 'login': {
            // **不接受把密码写在命令文本里**：那会进会话记录（本插件的红线是"秘密不进日志/结果"）。
            // 这里走授权流交互输入，输入框是 secret 类型；然后用账号密码换一次 Token 来验证。
            if (rest.length > 0) {
              return {
                kind: 'error',
                text: '用法：/zentao login（不带参数 —— 会交互式询问账号与密码）。\n' +
                  '不要在命令里直接写密码：命令文本会进入会话记录。也可以直接在设置页的"禅道"卡片里填写。',
              }
            }
            const authorization = ctx.get('authorization')
            if (!authorization) {
              return {
                kind: 'error',
                text: '当前组合没有授权服务。请在设置页的"禅道"卡片填写账号与密码，' +
                  '或在启动 Harness 前导出环境变量 ZENTAO_ACCOUNT / ZENTAO_PASSWORD。',
              }
            }
            const done = []
            // **`begin()` 收的是对象**（`{ key, method?, signal? }`），不是 key 本身 ——
            // 真机踩过：`begin(passwordRecordKey())` 会让 `request.key` 变成 undefined，
            // 授权服务于是抛 `[NO_FLOW] no authorization flow is registered for "undefined"`。
            // 依据：dsh-authorization/lib/index.js 里 `const { key } = request`。
            const password = await authorization.begin({ key: passwordRecordKey() })
            if (password?.status !== 'authorized') {
              return { kind: 'error', text: `密码授权未完成（${password?.status ?? '未知'}）。` }
            }
            done.push('密码已保存')
            const account = await authorization.begin({ key: accountRecordKey() })
            if (account?.status !== 'authorized') {
              return { kind: 'error', text: `${done.join('；')}；账号授权未完成（${account?.status ?? '未知'}）。` }
            }
            done.push('账号已保存')
            try {
              const verified = await tokenSource.verify()
              done.push(`换取 API Token 成功（${verified.tokenLength} 字符，仅内存缓存、不落盘）`)
            } catch (error) {
              return {
                kind: 'error',
                text: `${done.join('；')}。但**换取 Token 失败**：${error?.message ?? error}`,
              }
            }
            return { kind: 'success', text: `${done.join('；')}。` }
          }

          case 'switch': {
            // **不带参数就列出产品与编号** —— 用户看不到 id 是真实痛点：
            // 原来这里只回一句"用法：/zentao switch <产品id>"，等于让人去猜编号。
            // 注意：查询结果的编号在 `item.ref.id`（投影形状是 {ref:{entity,id}, title, …}），
            // 不是 `item.id` —— 第一版就写成 item.id，列出来是 `#undefined`。
            const idOf = (item) => String(item?.ref?.id ?? item?.id ?? '')
            const titleOf = (item) => item?.title ?? item?.name ?? '(无标题)'
            const listProducts = async (header) => {
              try {
                const result = await service.query({ entity: 'product', page: 1, limit: 20 })
                if (!result.items?.length) {
                  return `${header}\n当前站点没有可用的产品（历史产品请另查，或先在禅道里建一个）。`
                }
                const lines = [header, '可用的产品（用编号或名称都可以）：']
                for (const item of result.items) {
                  lines.push(`  #${idOf(item)}  ${titleOf(item)}`)
                }
                lines.push('', '用法：/zentao switch <产品编号或名称> [执行编号]')
                return lines.join('\n')
              } catch (error) {
                return `${header}\n读取产品列表失败：${error?.message ?? error}`
              }
            }

            const [rawProduct, executionId] = rest
            if (!rawProduct) {
              return { kind: 'success', text: await listProducts('禅道会话上下文：还没有设置。') }
            }

            // 既接受编号，也接受**产品名称**（精确匹配优先；不唯一时把候选列出来，而不是猜一个）
            let productId = rawProduct
            let productTitle
            if (!/^\d+$/.test(rawProduct)) {
              const listed = await service.query({ entity: 'product', page: 1, limit: 100 })
                .catch(() => ({ items: [] }))
              const needle = rawProduct.trim().toLowerCase()
              const named = (listed.items ?? []).map((item) => ({ id: idOf(item), title: titleOf(item) }))
              const exact = named.filter((item) => item.title.trim().toLowerCase() === needle)
              const partial = named.filter((item) => item.title.toLowerCase().includes(needle))
              const matches = exact.length > 0 ? exact : partial
              if (matches.length === 0) {
                return { kind: 'error', text: await listProducts(`没有找到名称匹配「${rawProduct}」的产品。`) }
              }
              if (matches.length > 1) {
                const lines = [`「${rawProduct}」匹配到 ${matches.length} 个产品，请用编号指定：`]
                for (const item of matches) lines.push(`  #${item.id}  ${item.title}`)
                return { kind: 'error', text: lines.join('\n') }
              }
              productId = matches[0].id
              productTitle = matches[0].title
            }

            try {
              const product = await service.get({ entity: 'product', id: productId })
              productTitle = product.item?.title ?? productTitle ?? '(无标题)'
            } catch (error) {
              return {
                kind: 'error',
                text: `无法读取产品 #${productId}：${error?.message ?? error}\n\n` +
                  await listProducts('可用的产品：'),
              }
            }
            sessionContext.set(sessionId, { productId, executionId, productTitle })
            return {
              kind: 'success',
              text: `已把本会话的禅道上下文设为：产品 ${productTitle}（#${productId}）` +
                `${executionId ? `，执行 #${executionId}` : ''}。\n` +
                '之后调用 zentao_query / zentao_write 时可以省略 scope，插件会用这个上下文补全。',
            }
          }

          case 'board': {
            const [executionId] = rest
            if (!executionId) return { kind: 'error', text: '用法：/zentao board <执行id>' }
            const result = await service.board({ scope: 'execution', id: executionId })
            const lines = [`执行 #${executionId} 看板`]
            for (const group of result.counts) {
              lines.push(`  ${group.label}：共 ${group.total}（${group.byStatus.map(([s, c]) => `${s} ${c}`).join(' / ')}）`)
            }
            if (result.blockers.length > 0) {
              lines.push('', `阻塞/逾期 ${result.blockers.length} 项：`)
              result.blockers.slice(0, 5).forEach((item, index) => lines.push(renderLine(item, index)))
            }
            return { kind: 'success', text: lines.join('\n') }
          }

          default:
            return { kind: 'error', text: `不认识的子命令 "${sub}"。\n\n${USAGE}` }
        }
      } catch (error) {
        const code = error?.code ?? CODES.INTERNAL
        return { kind: 'error', text: `[${code}] ${error?.message ?? error}` }
      }
    },
  })
}
