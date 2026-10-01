/**
 * 凭据解析与授权流：**禅道账号 + 密码**登录。
 *
 * 为什么不把密码带去每个请求：禅道 REST v1 **只认 `Token` 请求头**（已实测；
 * 账号密码只能用来调 `POST /tokens` 换 Token）。所以本插件的认证链路是：
 *
 *   凭据库存【账号 + 密码】 → 用它们 POST /tokens 换取 Token（**只缓存在内存里**）
 *   → 请求带 `Token` 头 → 收到 401 时丢掉缓存、下次自动重换一次。
 *
 * 落盘的东西：账号与密码（在 DSH 凭据库里）。
 * **不落盘的东西**：换取到的 Token（只在内存缓存里，进程重启即失效）、任何会话 Cookie。
 *
 * 凭据优先级（每一项都独立解析）：
 *   1) 进程环境变量 / 凭据库里的引用值（`ctx.credentials.resolve` 内部已覆盖环境）
 *   2) 凭据记录（授权流写入的 `dsh-plugin-zentao/account` 与 `.../password`）
 *   3) 都没有 → 返回 undefined，由上层抛 `AUTH_REQUIRED`
 */

import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { CODES, ZenTaoError } from './domain/errors.js'

/** 凭据记录：单站点，固定 id。 */
export const ACCOUNT_RECORD_ID = 'account'
export const PASSWORD_RECORD_ID = 'password'
export const CREDENTIAL_RECORD_OWNER = 'dsh-plugin-zentao'

/** 默认引用名（配置里只出现名字，值在凭据库/环境变量里）。 */
export const DEFAULT_ACCOUNT_REF = 'ZENTAO_ACCOUNT'
export const DEFAULT_PASSWORD_REF = 'ZENTAO_PASSWORD'

/** 换取到的 Token 在内存里存活多久。实测禅道不返回有效期，取一个保守值并在 401 时立刻失效。 */
export const TOKEN_TTL_MS = 30 * 60 * 1000

export function accountRecordKey () {
  return credentialKey(CREDENTIAL_RECORD_OWNER, ACCOUNT_RECORD_ID)
}

export function passwordRecordKey () {
  return credentialKey(CREDENTIAL_RECORD_OWNER, PASSWORD_RECORD_ID)
}

const refNameOf = (config, key, fallback) => {
  const value = config?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * 解析一项凭据：引用值（含环境变量）→ 凭据记录 → undefined。
 * 任何一步出错都不带崩整条链路（引用名非法、凭据服务拒绝等）。
 */
async function resolveOne (ctx, { refName, recordKey, payloadKey, envName, secrets }) {
  const credentials = ctx.get('credentials')

  if (!credentials || secrets) {
    // 没有凭据服务（极简组合）时退回进程环境变量并如实记录成因。
    const ambient = typeof process !== 'undefined' ? process.env?.[envName] : undefined
    if (typeof ambient === 'string' && ambient !== '') return ambient
    if (!credentials) return undefined
  }

  try {
    const hit = await credentials.resolve(credentialRef(refName))
    if (typeof hit?.value === 'string' && hit.value !== '') return hit.value
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }

  try {
    const record = await credentials.readRecord(recordKey)
    const value = record?.payload?.[payloadKey]
    if (typeof value === 'string' && value.trim() !== '') return value
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }

  return undefined
}

/** 解析账号（非密）。 */
export function resolveAccount (ctx, config) {
  return resolveOne(ctx, {
    refName: refNameOf(config, 'accountRef', DEFAULT_ACCOUNT_REF),
    recordKey: accountRecordKey(),
    payloadKey: 'account',
    envName: 'ZENTAO_ACCOUNT',
    secrets: false,
  })
}

/** 解析密码（密；**永不写进日志、配置与工具结果**）。 */
export function resolvePassword (ctx, config) {
  return resolveOne(ctx, {
    refName: refNameOf(config, 'passwordRef', DEFAULT_PASSWORD_REF),
    recordKey: passwordRecordKey(),
    payloadKey: 'password',
    envName: 'ZENTAO_PASSWORD',
    secrets: true,
  })
}

/**
 * 凭据的存在性与可写性（设置页与诊断用；**永不返回值本体**）。
 * @returns {Promise<{account: object, password: object}>}
 */
export async function describeAuth (ctx, config) {
  const credentials = ctx.get('credentials')
  const describe = async (refName, recordKey, envName, recordId) => {
    if (!credentials) {
      return {
        ref: refName,
        configured: typeof process !== 'undefined' && Boolean(process.env?.[envName]),
        source: 'process-env',
        writable: false,
      }
    }
    try {
      const info = await credentials.describe(credentialRef(refName))
      if (info?.configured) return { ref: refName, ...info }
    } catch { /* 引用名非法等：落到记录检查 */ }
    try {
      const record = await credentials.describeRecord(recordKey)
      if (record?.configured) return { ref: refName, record: recordId, ...record }
    } catch { /* 同上 */ }
    return { ref: refName, configured: false, writable: true }
  }

  return {
    account: await describe(
      refNameOf(config, 'accountRef', DEFAULT_ACCOUNT_REF), accountRecordKey(), 'ZENTAO_ACCOUNT', ACCOUNT_RECORD_ID),
    password: await describe(
      refNameOf(config, 'passwordRef', DEFAULT_PASSWORD_REF), passwordRecordKey(), 'ZENTAO_PASSWORD', PASSWORD_RECORD_ID),
  }
}

/**
 * 写入一项凭据（设置页与授权流共用）。
 * 优先写"引用值"（设置页看到的就是它）；被只读来源遮蔽时退回凭据记录并说明原因。
 */
export async function saveCredential (ctx, config, kind, value) {
  const spec = kind === 'account'
    ? { refName: refNameOf(config, 'accountRef', DEFAULT_ACCOUNT_REF), recordKey: accountRecordKey(), payloadKey: 'account', label: '账号' }
    : { refName: refNameOf(config, 'passwordRef', DEFAULT_PASSWORD_REF), recordKey: passwordRecordKey(), payloadKey: 'password', label: '密码' }

  const text = String(value ?? '').trim()
  if (text === '') {
    throw new ZenTaoError(CODES.VALIDATION, `${spec.label}不能为空。`)
  }
  const credentials = ctx.get('credentials')
  if (!credentials) {
    throw new ZenTaoError(CODES.UNSUPPORTED, `当前组合没有凭据服务，无法保存${spec.label}。`)
  }

  try {
    await credentials.set(credentialRef(spec.refName), text)
    return { stored: 'reference', ref: spec.refName, kind }
  } catch (error) {
    await credentials.modifyRecord(spec.recordKey, () =>
      Promise.resolve({ kind: 'grant', payload: { [spec.payloadKey]: text, obtainedVia: 'credentials' } }))
    return {
      stored: 'record',
      ref: spec.refName,
      kind,
      note: `引用值写入被拒（${error?.message ?? error}），已改写凭据记录。`,
    }
  }
}

/**
 * 造一个 Token 来源：**换取 + 内存缓存 + 失效**。
 *
 * 缓存是刻意的：`POST /tokens` 每次换出来的都是新 Token（实测两次结果不同），
 * 每请求换一次既浪费又容易触发风控。缓存只在内存，进程重启即重新换取。
 *
 * @param {object} ctx
 * @param {() => object} getConfig
 * @param {object} service 需要 `exchangeToken({account,password,signal})`
 */
export function createTokenSource (ctx, getConfig, service) {
  let cached // { token, at }
  let inflight // 并发去重：多个请求同时发现需要换 Token 时只换一次

  const invalidate = () => { cached = undefined }

  async function mint (signal) {
    const config = getConfig()
    const account = await resolveAccount(ctx, config)
    const password = await resolvePassword(ctx, config)
    if (!account || !password) {
      throw new ZenTaoError(
        CODES.AUTH_REQUIRED,
        '缺少禅道账号或密码：请在设置页填写（或运行 /zentao login）。',
        {
          facts: { accountConfigured: Boolean(account), passwordConfigured: Boolean(password) },
          hint: '凭据走 DSH 凭据库：设置页的"禅道"卡片可以填账号与密码，' +
            '也可以在启动前导出环境变量 ZENTAO_ACCOUNT / ZENTAO_PASSWORD（或你在配置里指定的引用名）。',
        },
      )
    }
    const { token } = await service.exchangeToken({ account, password, signal })
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ZenTaoError(CODES.AUTH_REQUIRED, '禅道没有返回 API Token（账号密码错误，或该站点未开放 API）。')
    }
    cached = { token: token.trim(), at: Date.now() }
    return cached.token
  }

  return {
    /** 取一个可用 Token（必要时换取）。 */
    async get (signal) {
      if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token
      if (inflight === undefined) {
        inflight = mint(signal).finally(() => { inflight = undefined })
      }
      return inflight
    },
    /** 丢掉缓存（收到 401 时调用，下次会重新换取）。 */
    invalidate,
    /** 主动校验账号密码是否可用（"测试连接"）：换一次 Token 但不返回它。 */
    async verify (signal) {
      invalidate()
      const token = await mint(signal)
      return { ok: true, tokenLength: token.length }
    },
  }
}

/**
 * 向人提问，并对 `kind` 做一次优雅回退。
 *
 * 为什么需要：`dsh-authorization` **不校验 kind**（它只是把 `interaction.prompt(request)` 转发给
 * 发起该流程的界面），所以"密文输入"是否被支持取决于具体 surface。为了不把用户卡在一个未知
 * kind 上：`secret` 被拒时退回授权文档里给出的 `text`，并在提示里说明会明文显示。
 * ⚠️ 人的"不"（`AuthorizationDeclinedError`，code `DECLINED`）**不是**故障，必须原样抛出。
 */
async function ask (session, request) {
  try {
    return await session.prompt(request)
  } catch (error) {
    const declined = error?.code === 'DECLINED' || /declin/i.test(String(error?.message ?? ''))
    if (declined || request.kind !== 'secret') throw error
    return session.prompt({
      ...request,
      kind: 'text',
      message: `${request.message}\n（当前界面不支持密文输入，输入内容会明文显示；更推荐去设置页的"禅道"卡片填写。）`,
    })
  }
}

/**
 * 提交一条凭据记录。
 *
 * 优先用**框架给的 `session.commit()`**：真实授权服务用它确认"这次尝试里提交过记录"
 * （`dsh-authorization` 会监听 `credentials/record-updated` 事件，并在流程结束后校验
 * `observed.committed`，否则抛 `NOT_COMMITTED`），而且它内部就是用**流程自己的 key**
 * 调 `credentials.modifyRecord`，不会写错键。
 * 没有 `commit` 时（简化 surface / 测试桩）退回直接写记录。
 */
async function commitRecord (ctx, session, key, record) {
  if (typeof session?.commit === 'function') return session.commit(record)
  return ctx.credentials.modifyRecord(key, () => Promise.resolve(record))
}

/**
 * 注册授权流。契约要点（已核验 `dsh-authorization`）：
 *   - 流程**必须在 resolve 之前**提交记录（用 `session.commit()`），否则 NOT_COMMITTED；
 *   - 每个 key 同一时刻只允许一次尝试；
 *   - 人的"不"是 `cancelled` 结果，不是故障；
 *   - **`begin()` 收的是对象** `{ key, method?, interaction?, signal? }`（真机踩过，见 src/commands.js）。
 *
 * 这里注册两个 key（账号、密码），人只需要在缺哪一项时补哪一项。
 */
export function registerAuthorizationFlow (ctx, config) {
  const authorization = ctx.get('authorization')
  if (!authorization) return undefined
  const disposers = []

  disposers.push(authorization.registerFlow({
    key: passwordRecordKey(),
    label: `禅道 · ${config.label || '禅道'}`,
    methods: [{ id: 'password', label: '输入禅道密码' }],
    async run (session) {
      const password = await ask(session, {
        kind: 'secret',
        message: '请输入禅道登录密码（用于自动换取 API Token，只存进 DSH 凭据库）',
      })
      if (String(password ?? '').trim() === '') {
        throw new ZenTaoError(CODES.VALIDATION, '没有收到密码。')
      }
      await commitRecord(ctx, session, passwordRecordKey(),
        { kind: 'grant', payload: { password: String(password).trim(), obtainedVia: 'credentials' } })
    },
  }))

  disposers.push(authorization.registerFlow({
    key: accountRecordKey(),
    label: `禅道 · ${config.label || '禅道'}`,
    methods: [{ id: 'account', label: '输入禅道账号' }],
    async run (session) {
      const account = await ask(session, {
        kind: 'text',
        message: '请输入禅道登录账号（如 admin）',
      })
      if (String(account ?? '').trim() === '') {
        throw new ZenTaoError(CODES.VALIDATION, '没有收到账号。')
      }
      await commitRecord(ctx, session, accountRecordKey(),
        { kind: 'grant', payload: { account: String(account).trim(), obtainedVia: 'credentials' } })
    },
  }))

  return () => { for (const off of disposers) { try { off?.() } catch { /* 拆除失败不致命 */ } } }
}

/**
 * 保存账号与密码，并**立刻验证一次**（换 Token 成功才算真正可用）。
 * ⚠️ 密码只作为函数参数存在：进入凭据库的是它，但它**不进入配置、不进入日志、不进入工具结果**。
 */
export async function saveAndVerifyCredentials (ctx, config, tokenSource, { account, password, signal }) {
  const saved = []
  if (account !== undefined && String(account).trim() !== '') {
    saved.push(await saveCredential(ctx, config, 'account', account))
  }
  if (password !== undefined && String(password).trim() !== '') {
    saved.push(await saveCredential(ctx, config, 'password', password))
  }
  if (saved.length === 0) {
    throw new ZenTaoError(CODES.VALIDATION, '需要提供账号或密码。')
  }
  const verified = await tokenSource.verify(signal)
  return { saved, verified }
}
