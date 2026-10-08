/**
 * 生成 `src/transport/dialects/rest-v2.routes.js`。
 *
 * 数据来源：**官方 SDK** `zentao-api`（随官方 `zentao-cli` 一起发布，MIT）里的
 * `dist/modules/generated.js` —— 26 个模块、每个动作的 `method`/`path`/`minVersion`/
 * `resultGetter`/`pagerGetter`/`pathParams`/`params`。这是官方给出的**权威 v2 契约**：
 * 官方 CLI 就是照它决定"这个动作在你这台服务器上能不能用"（按 `minVersion` 里的 ipd/企业/旗舰系列比较）。
 *
 * 为什么要生成而不是手写：手写必错、且无法随官方更新而更新。这个脚本只做**裁剪**（丢掉描述
 * 与展示文案，保留判定所需的字段），不改写任何路径。
 *
 * 用法（默认指向本机全局安装的 zentao-cli）：
 *   node scripts/gen-rest-v2-routes.mjs [registryJsonOrPackageDir]
 *
 * 生成后的文件**不要手改** —— 改这个脚本然后重跑。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_SOURCE = 'D:/Program Files/nodejs/node_global/node_modules/zentao-cli/node_modules/zentao-api/dist/modules/generated.js'

/** 只保留判定所需的字段，丢弃描述/展示/示例（真正的契约是 path + method + minVersion）。 */
function trimAction (action) {
  const ipd = (action.minVersion ?? []).find((version) => String(version).startsWith('ipd'))
  const out = {
    name: action.name,
    method: String(action.method ?? 'get').toUpperCase(),
    path: action.path,
  }
  if (ipd !== undefined) out.ipd = ipd
  if (action.resultGetter !== undefined) out.getter = action.resultGetter
  if (action.pagerGetter !== undefined) out.pager = action.pagerGetter
  if (action.type !== undefined) out.type = action.type
  const pathParams = Object.keys(action.pathParams ?? {})
  if (pathParams.length > 0) out.pathParams = pathParams
  // 参数：名字/是否必填/位置/枚举值 —— 够做校验与文档，不搬描述
  const params = []
  for (const param of action.params ?? []) {
    if (param?.name === undefined) continue
    const entry = { name: param.name }
    if (param.required === true) entry.required = true
    if (param.in !== undefined) entry.in = param.in
    if (Array.isArray(param.options) && param.options.length > 0) {
      entry.values = [...new Set(param.options.map((option) => option?.value).filter((v) => v !== undefined))]
    }
    if (param.defaultValue !== undefined) entry.default = param.defaultValue
    params.push(entry)
  }
  if (params.length > 0) out.params = params
  return out
}

const source = process.argv[2] ?? DEFAULT_SOURCE
const registryPath = source.endsWith('.js')
  ? source
  : path.join(source, 'dist/modules/generated.js')

if (!fs.existsSync(registryPath)) {
  console.error(`找不到官方注册表：${registryPath}`)
  console.error('请传入 zentao-api 包目录或 generated.js 的路径。')
  process.exit(1)
}

const { BUILTIN_MODULES } = await import(`file://${registryPath.replaceAll('\\', '/')}`)
const modules = {}
for (const mod of BUILTIN_MODULES) {
  modules[mod.name] = (mod.actions ?? []).map(trimAction)
}

// 从生成的代码里拿不到包版本，就读它旁边的 package.json（出处可追溯）
let apiVersion = 'unknown'
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(registryPath), '../../package.json'), 'utf8'))
  apiVersion = pkg.version ?? 'unknown'
} catch { /* 读不到就如实写 unknown */ }

const header = `/**
 * 禅道 REST **v2** 路由表 —— **自动生成，不要手改**。
 *
 * 生成方式：\`node scripts/gen-rest-v2-routes.mjs\`
 * 数据来源：官方 SDK \`zentao-api@${apiVersion}\`（随官方 \`zentao-cli\` 发布，MIT）的
 *          \`dist/modules/generated.js\`。官方 CLI 正是照这张表决定动作可用性
 *          （\`ipd\` 字段就是该动作要求的最低 IPD 版本，例如 \`ipd5.5\`）。
 *
 * 本文件只保留**判定所需**的字段（method/path/minVersion/resultGetter/pagerGetter/
 * pathParams/params 的名字与枚举值），描述与展示文案都已裁掉。
 * 这是**接口事实**（路径与方法），不是官方代码的拷贝。
 *
 * 纯数据模块：不 import 任何东西。
 */

/* eslint-disable */
`

const body = `export const REST_V2_MODULES = ${JSON.stringify(modules, null, 2)}

/** 生成时的官方 SDK 版本（写进诊断，便于日后复现）。 */
export const REST_V2_SOURCE = Object.freeze({ package: 'zentao-api', version: ${JSON.stringify(apiVersion)} })

/** 取一个模块的动作表（模块不存在时返回空数组）。 */
export function v2Actions (moduleName) {
  return REST_V2_MODULES[moduleName] ?? []
}

/** 取一个动作定义（找不到返回 undefined）。 */
export function v2Action (moduleName, actionName) {
  return v2Actions(moduleName).find((action) => action.name === actionName)
}
`

const target = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../src/transport/dialects/rest-v2.routes.js',
)
fs.writeFileSync(target, `${header}\n${body}`, 'utf8')

const actionCount = Object.values(modules).reduce((sum, list) => sum + list.length, 0)
console.log(`已生成 ${target}`)
console.log(`  模块 ${Object.keys(modules).length} 个 / 动作 ${actionCount} 个 / 来源 zentao-api@${apiVersion}`)
