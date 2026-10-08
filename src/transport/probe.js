/**
 * 方言能力探测梯。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`（transport 由调用方注入）。
 * 设计依据：design/02-detailed-design.md §7.5。
 *
 * 整个探测梯的关键是**把 401 与 404 分开**：
 *   401 → 方言正确，只是凭据缺失/失效 → 立刻引导认证，**不再往下探**；
 *   404 / HTML / 结构不符 → 才说明方言不对 → 换下一档。
 * 写错这一条会把"没登录"报成"版本不支持"，把用户引向完全错误的排查方向。
 */

import { CODES, ZenTaoError, redact } from '../domain/errors.js'
import { looksLikeHtml, looksLikeJson } from './client.js'
import { PROBE_ORDER, dialectOf } from './dialects/index.js'

/** 探测结论的结构版本：字段或语义变更时递增，旧缓存据此失效。 */
export const PROBE_VERSION = 1

/** 判定响应体是否"看起来像" REST v1 的列表信封（`{page,total,limit,<复数>}`）。 */
export function looksLikeListEnvelope (json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false
  const hasArrayValue = Object.values(json).some((value) => Array.isArray(value))
  const hasMeta = ['total', 'page', 'limit', 'pager'].some((key) => json[key] !== undefined)
  return hasArrayValue || hasMeta
}

/** 判定响应体是否像"当前用户"对象（详情形态：裸对象且带 id 或 account）。 */
export function looksLikeUserObject (json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false
  return json.id !== undefined || json.account !== undefined
}

/**
 * 探测端点序列。
 *
 * **为什么不止一个端点**：企业版各模块的权限是独立的，只探产品列表会把
 * "这个账号没有产品权限"（403）误报成"方言不支持"，把本来可用的账号挡在门外。
 * `/user` 是任何已认证账号都能访问的兜底端点，所以放在最后一档：
 * 它能单独证明"这个前缀是对的、Token 是有效的"。
 */
const PROBE_STEPS = [
  { key: 'product', label: '产品列表' },
  { key: 'project', label: '项目列表' },
  { key: 'me', label: '当前用户' },
]

/**
 * 按探测步骤构造请求规格。
 *
 * `meSpec()` 可能返回 undefined（v2 没有"当前用户"端点，且账号本来就在凭据里）——
 * 这时**跳过**这一步，而不是拿 undefined 去发请求（那会直接抛，把整个探测带崩）。
 */
function specForStep (dialect, step) {
  if (step.key === 'me') return dialect.meSpec()
  return dialect.listSpec(step.key, { page: 1, limit: 1 })
}

/** 该方言是否支持这个探测步骤。 */
function supportsStep (dialect, step) {
  return specForStep(dialect, step) !== undefined
}

/** 判定一个探测响应是否"命中"。 */
function isHit (step, response) {
  if (!response.ok || !looksLikeJson(response)) return false
  return step.key === 'me' ? looksLikeUserObject(response.json) : looksLikeListEnvelope(response.json)
}

/**
 * 执行探测。
 * @param {object} params
 * @param {import('./client.js').Transport} params.transport
 * @param {string} params.base      已归一化的 baseURL
 * @param {string|undefined} params.token  可能为空（此时 401 是预期结果）
 * @param {'auto'|'rest-v1'|'rest-v2'|'legacy-api'} [params.configured]
 * @returns {Promise<{dialectId:string, dialectLabel:string, probedAt:string, version?:string, facts:object[], probeVersion:number}>}
 */
export async function probeDialect ({ transport, base, token, configured = 'auto', order: orderOverride }) {
  // `order` 覆盖用于**严格 v2-only**：把候选收窄成只剩 v2，避免 `auto` 落到 v1
  // （否则 avoidV1 形同虚设 —— 解析成 v1 方言之后请求就真的打到 /api.php/v1 了）。
  const order = Array.isArray(orderOverride) && orderOverride.length > 0
    ? [...orderOverride]
    : (configured && configured !== 'auto' ? [configured] : [...PROBE_ORDER])
  const facts = []
  let sawAuthSignal = false
  let sawForbiddenOnly = false
  let forbiddenDialect

  for (const id of order) {
    let dialect
    try {
      dialect = dialectOf(id)
    } catch (error) {
      facts.push({ dialect: id, outcome: 'unavailable', detail: error?.message })
      continue
    }

    if (dialect.implemented === false) {
      // 未实现的方言不可能是命中项，但要把"试过了、没实现"记进事实表
      facts.push({ dialect: id, outcome: 'not-implemented' })
      continue
    }

    const apiBase = `${String(base).replace(/\/+$/, '')}${dialect.basePath ?? ''}`
    const headers = token ? dialect.authHeaders(token) : dialect.authHeaders('')
    /** 该方言下被 403 拒绝的端点：方言可能对，只是这个账号没权限。 */
    const denied = []
    let stopped = false

    for (const step of PROBE_STEPS) {
      // 该方言没有这个步骤（例如 v2 没有 me 端点）→ 跳过并如实记一笔，不要拿 undefined 去请求
      if (!supportsStep(dialect, step)) {
        facts.push({ dialect: id, step: step.key, outcome: 'not-supported' })
        continue
      }
      let spec
      try {
        spec = specForStep(dialect, step)
      } catch (error) {
        facts.push({ dialect: id, step: step.key, outcome: 'spec-failed', detail: error?.message })
        continue
      }

      let response
      try {
        response = await transport.request({ base: apiBase, ...spec, headers })
      } catch (error) {
        // 网络/超时：探测无法继续，如实抛出并带走事实
        if (error instanceof ZenTaoError) {
          error.facts = { ...(error.facts ?? {}), probe: facts }
          throw error
        }
        throw error
      }

      if (response.status === 401) {
        sawAuthSignal = true
        facts.push({ dialect: id, step: step.key, outcome: 'auth-required', status: 401, contentType: response.contentType })
        // 方言（前缀）正确、Token 无效 —— 不再往下探任何端点或方言
        stopped = true
        break
      }
      if (response.status === 403) {
        // 关键：403 **不中止整轮**。这个账号可能只是没有"产品"权限，
        // 但 `/user` 或项目列表仍然可用。记录后继续下一档端点。
        denied.push(step.key)
        facts.push({ dialect: id, step: step.key, outcome: 'forbidden', status: 403 })
        continue
      }
      if (isHit(step, response)) {
        facts.push({ dialect: id, step: step.key, outcome: 'hit', status: response.status })
        return {
          dialectId: id,
          dialectLabel: dialect.label,
          probedAt: new Date().toISOString(),
          version: detectVersion(response),
          facts,
          probeVersion: PROBE_VERSION,
          // 哪些端点被拒：这对用户很有用（"你的账号只能看到 /user"）
          denied: denied.length > 0 ? denied : undefined,
          hitEndpoint: step.key,
        }
      }

      facts.push({
        dialect: id,
        step: step.key,
        outcome: looksLikeHtml(response) ? 'html-response' : 'shape-mismatch',
        status: response.status,
        contentType: response.contentType,
        bodyHead: typeof response.text === 'string' ? redact(response.text.slice(0, 120)) : undefined,
      })
    }

    if (stopped) break

    // 这个方言下**每个**端点都是 403：前缀对、Token 有效，但账号没有这些权限
    if (denied.length === PROBE_STEPS.length) {
      sawForbiddenOnly = true
      forbiddenDialect = id
    }
  }

  if (sawAuthSignal) {
    if (!token) {
      throw new ZenTaoError(
        CODES.AUTH_REQUIRED,
        '禅道接口已找到，但还没有可用的 API Token。',
        { facts: { probe: facts } },
      )
    }
    throw new ZenTaoError(
      CODES.AUTH_EXPIRED,
      '禅道拒绝了当前 API Token。',
      { facts: { probe: facts } },
    )
  }

  if (sawForbiddenOnly) {
    throw new ZenTaoError(
      CODES.FORBIDDEN,
      '禅道可访问、Token 也有效，但该账号对探测端点（产品列表、项目列表、当前用户）都没有权限。',
      {
        facts: { dialect: forbiddenDialect, probe: facts },
        hint: '请让管理员给该账号至少开放"当前用户"或某个列表的访问权限；也可以用另一个账号的 Token 试试。',
      },
    )
  }

  throw new ZenTaoError(
    CODES.UNSUPPORTED,
    '没有探测到可用的禅道接口方言。',
    {
      facts: { tried: order, probe: facts },
      hint: '请确认 baseURL 是否正确（例如是否少了 /zentao 子目录）、禅道后台是否开启了 API，' +
        '或在设置页把 dialect 手工指定为 rest-v1 后重试。',
    },
  )
}

/**
 * 取**权威**服务器版本：`GET <base>/?mode=getconfig`。
 *
 * 实测响应：`{"version":"ipd5.6","requestType":"PATH_INFO","requestFix":"-","systemMode":"PLM",…}`
 * （官方 Agent 技能文档也把 `?mode=getconfig` 列为核对站点配置的手段 —— 见 E2011/E2012 的处理建议）。
 *
 * 为什么需要它：官方 v2 注册表里**每个动作**都带最低版本（如 `ipd5.5`），
 * 拿不到版本就没法给出可读的门禁错误，只能让它 404。取不到时如实返回 undefined。
 */
export async function fetchServerVersion ({ transport, base, signal }) {
  try {
    const response = await transport.request({
      base,
      method: 'GET',
      path: '/',
      query: { mode: 'getconfig' },
      signal,
    })
    const version = response?.json?.version
    if (typeof version === 'string' && version.trim() !== '') return version.trim()
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 尽力读取版本串。文档未提供版本端点，故只做**保守**的尽力而为：
 * 优先看常见响应头，其次看响应体里的 `version` 字段；都不像就返回 undefined。
 * 不做任何猜测式解析（宁可没有版本号，也不要一个错的）。
 */
export function detectVersion (response) {
  const headerValue = response?.headers?.['x-zentao-version'] ?? response?.headers?.['x-powered-by']
  if (typeof headerValue === 'string' && /^[\d.]+\s*$/.test(headerValue.trim())) {
    return headerValue.trim()
  }
  const body = response?.json
  if (body !== null && typeof body === 'object' && typeof body.version === 'string' && /^[\d.]/.test(body.version)) {
    return body.version
  }
  return undefined
}

/** 把探测结论渲染成中文事实表（给 `/zentao doctor` 与错误提示用）。 */
export function describeProbe (result) {
  const lines = [
    `方言：${result.dialectLabel}（${result.dialectId}）`,
    `探测时间：${result.probedAt}`,
  ]
  if (result.hitEndpoint) lines.push(`命中端点：${result.hitEndpoint}`)
  if (Array.isArray(result.denied) && result.denied.length > 0) {
    lines.push(`被拒端点（403，账号无权限）：${result.denied.join('、')}`)
  }
  if (result.version) lines.push(`版本串（尽力而为）：${result.version}`)
  if (Array.isArray(result.facts) && result.facts.length > 0) {
    lines.push('探测过程：')
    for (const fact of result.facts) {
      const extra = [fact.status ? `HTTP ${fact.status}` : undefined, fact.contentType, fact.detail]
        .filter(Boolean).join(' / ')
      const step = fact.step ? `${fact.step} ` : ''
      lines.push(`  - ${fact.dialect}: ${step}${fact.outcome}${extra ? `（${extra}）` : ''}`)
    }
  }
  return lines.join('\n')
}
