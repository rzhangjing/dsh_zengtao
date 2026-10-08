/**
 * 方言注册表。
 *
 * `rest-v1`  —— 企业版 6.0+ 起提供的 REST v1；逐条真机校准过（最稳）。
 * `rest-v2`  —— 官方新一代 API（手册第 1 章）。**路径来自官方 SDK 注册表**（生成物），
 *               认证/错误解析/写字段语义复用 v1。v2 没有的动作（assign/log_effort/comment）
 *               回退 v1 已校准端点；取 Token 永远走 v1（v2 无 tokens 端点，实测确认）。
 * `legacy-api` —— 传统 api.php；可选、不排期（保留以给出准确诊断）。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 */

import { CODES, ZenTaoError } from '../../domain/errors.js'
import { createRestV1Dialect } from './rest-v1.js'
import { createRestV2Dialect } from './rest-v2.js'
import { legacyApiDialect } from './legacy-api.js'

/** 全部已知方言 id（供 Config 的 union 与诊断用）。 */
export const DIALECT_IDS = Object.freeze(['auto', 'rest-v1', 'rest-v2', 'legacy-api'])

/**
 * 探测梯的候选顺序（`auto` 时按此顺序尝试）。
 *
 * **v2 排在前面**（有证据的切换）：
 *   · 读：v2 已逐条真机校准，而且更完整（同上一个执行，v1 的需求只给 3 条、v2 给 5 条；
 *     v1 完全忽略 `browseType`，v2 是真服务端筛选；v2 的 `pageID`/`recPerPage` 会被采纳）；
 *   · 写：**能力不降级** —— 任务与 Bug 的写在 v2 路径上已实测校准（create/update/start/finish/
 *     close/delete、resolve/close），而 v2 注册表没有的（assign/log_effort）与实测未按注册表
 *     工作的（story 写：`POST /api.php/v2/stories` 返回网页端登录页 JSON）**整类回退 v1 已校准端点**，
 *     并沿用 v1 的 `verified` 判定。
 * v1 仍在梯子上：老服务器（v2 路由 404）会自动落到它。
 */
export const PROBE_ORDER = Object.freeze(['rest-v2', 'rest-v1', 'legacy-api'])

/**
 * 取方言实现。
 * @param {string} id
 * @param {{ base?: string, version?: string }} [options] `version` 是服务器版本（`GET /?mode=getconfig` 的
 *        `version`，例如 `ipd5.6`），v2 用它做动作级版本门禁（注册表里每个动作都带最低 IPD 版本）。
 */
export function dialectOf (id, options = {}) {
  switch (id) {
    case 'rest-v1':
      return createRestV1Dialect(options)
    case 'rest-v2':
      return createRestV2Dialect(options)
    case 'legacy-api':
      return legacyApiDialect
    default:
      throw new ZenTaoError(
        CODES.VALIDATION,
        `未知 dialect "${id}"。可用值：${DIALECT_IDS.join('、')}。`,
      )
  }
}
