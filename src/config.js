/**
 * 插件配置（schemastery）。
 *
 * 全部字段 `.volatile()`：DSH 的设置表单只暴露 volatile 字段，而 volatile 字段在
 * 运行时是**活引用**，必须用 `.get()` 读 —— 用户在设置页改完立即生效，无需重启。
 *
 * 单站点（D6）：没有 `sites[]`、没有 `defaultSite`、没有站点 id。
 *
 * ⚠️ 与设计稿的一处偏离：设计稿里的 `verifyTLS` 已**删除**。
 * 原因：Node 的全局 `fetch` 无法在不自建 undici Agent 的前提下关闭证书校验，
 * 而自建 Agent 会静默绕过 `dsh-http-proxy`（DSH 明令禁止，且有门禁检查）。
 * 因此自签名内网证书的正解是**在启动 DSH 之前**设置 `NODE_EXTRA_CA_CERTS`
 * 指向企业根证书；`/zentao doctor` 会如实报告该变量是否设置。
 *
 * ⚠️ `baseURL` 会经过 `normalizeBaseURL` 规范化：用户常从浏览器地址栏复制页面地址
 * （`http://host/zentao/my.html`），直接拼 API 会变成 `…/my.html/api.php/…`（必然失败）。
 * 规范化只裁掉页面尾巴，保留真实子目录。
 */

import z from '@deepseek-ai/schemastery'
import { DIALECT_IDS } from './transport/dialects/index.js'
import { normalizeBaseURL } from './domain/url.js'

export const Config = z.object({
  // ── 站点（单站点，扁平字段）─────────────────────────────
  baseURL: z.string().volatile()
    .description('禅道地址，如 https://zentao.example.com（可含 /zentao 子目录；不要带结尾斜杠）'),
  label: z.string().default('禅道').volatile()
    .description('站点显示名，出现在工具结果与看板标题里'),
  accountRef: z.string().role('credential-ref').default('ZENTAO_ACCOUNT').volatile()
    .description('禅道**登录账号**的凭据引用名。这里只放名字，账号本体存在 DSH 凭据库里'),
  passwordRef: z.string().role('credential-ref').default('ZENTAO_PASSWORD').volatile()
    .description('禅道**登录密码**的凭据引用名。密码只存 DSH 凭据库；换取到的 API Token 只缓存在内存里'),
  dialect: z.union([...DIALECT_IDS]).default('auto').volatile()
    .description('auto 自动探测；企业版 6.0+ 应为 rest-v1'),

  // ── 写入策略（D2 需要写操作）───────────────────────────
  writePolicy: z.union(['readonly', 'confirm', 'trusted']).default('confirm').volatile()
    .description('readonly 拒绝一切写入；confirm 每次写入都要用户确认；trusted 仅删除类需要确认'),
  allowBulkWrite: z.boolean().default(false).volatile()
    .description('批量写总闸。默认关闭'),
  maxBulkItems: z.number().step(1).min(1).max(200).default(20).volatile()
    .description('单次批量写的条数上限'),
  allowUnverifiedWrites: z.boolean().default(false).volatile()
    .description('允许执行"请求形状未经真机校准"的写操作。' +
      '默认关闭：官方手册没有给出这些动作的 REST 形状，盲目发送可能打到别的端点。' +
      '注意本机实测后**只剩 comment 一个动作**仍未校准（它在禅道 IPD 5.6 上根本没有对应路由），' +
      '其余写动作都已带真机证据。用 /zentao doctor 看未校准清单、用 dryRun 核实后再决定是否打开'),

  // ── 传输 ──────────────────────────────────────────────
  requestTimeoutMs: z.number().step(1000).min(1000).max(300000).default(20000).volatile()
    .description('单个请求的超时（毫秒）。与工具调用的取消信号融合'),
  maxRetries: z.number().step(1).min(0).max(5).default(2).volatile()
    .description('仅对幂等的 GET 请求重试；写操作永不自动重试'),
  maxPageSize: z.number().step(1).min(1).max(200).default(50).volatile()
    .description('单页硬上限，防止模型一次要一万条'),
  maxResultItems: z.number().step(1).min(1).max(200).default(20).volatile()
    .description('渲染进模型的条目上限；超出会明确告知"还有 N 条"'),
  cacheTtlSeconds: z.number().step(1).min(0).max(86400).default(300).volatile()
    .description('详情与"我是谁"的缓存 TTL（秒）。0 表示关闭缓存'),

  // ── 呈现（D3 工具描述为中文）───────────────────────────
  includeRawPayload: z.boolean().default(false).volatile()
    .description('在校准字段名时附带脱敏后的原始载荷：查询结果里给**首条**带上，详情里带上该条'),
  includeWebLinks: z.boolean().default(true).volatile()
    .description('在结果里附带禅道网页链接（深链格式尚未实测校准，如不正确可关闭）'),
  stripRichText: z.union(['strip', 'text', 'keep']).default('strip').volatile()
    .description('禅道正文的处理：strip 剥 HTML / text 去标签 / keep 原样（仍会截断并标注为不可信数据）'),
  timezone: z.string().default('Asia/Shanghai').volatile()
    .description('仅供未来的传统 api.php 方言使用（该方言当前未实现，因此这个字段目前无效果）；' +
      'REST v1 返回 UTC ISO-8601，无需换算'),
})

/** 把 volatile 引用与普通值统一取值，得到一个纯数据快照。 */
export function snapshotConfig (config) {
  const value = (field, fallback) => {
    if (field === undefined || field === null) return fallback
    if (typeof field.get === 'function') {
      const got = field.get()
      return got === undefined ? fallback : got
    }
    return field
  }
  return {
    // 规范化：从浏览器复制来的页面地址（…/my.html、…/index.php?m=…）会被裁成站点根。
    baseURL: normalizeBaseURL(value(config.baseURL, '')),
    label: value(config.label, '禅道'),
    accountRef: value(config.accountRef, 'ZENTAO_ACCOUNT'),
    passwordRef: value(config.passwordRef, 'ZENTAO_PASSWORD'),
    dialect: value(config.dialect, 'auto'),
    writePolicy: value(config.writePolicy, 'confirm'),
    allowBulkWrite: value(config.allowBulkWrite, false),
    maxBulkItems: value(config.maxBulkItems, 20),
    allowUnverifiedWrites: value(config.allowUnverifiedWrites, false),
    requestTimeoutMs: value(config.requestTimeoutMs, 20000),
    maxRetries: value(config.maxRetries, 2),
    maxPageSize: value(config.maxPageSize, 50),
    maxResultItems: value(config.maxResultItems, 20),
    cacheTtlSeconds: value(config.cacheTtlSeconds, 300),
    includeRawPayload: value(config.includeRawPayload, false),
    includeWebLinks: value(config.includeWebLinks, true),
    stripRichText: value(config.stripRichText, 'strip'),
    timezone: value(config.timezone, 'Asia/Shanghai'),
  }
}
