/**
 * 方言注册表。
 *
 * `rest-v1`  —— 唯一必做方言（D1：企业版，REST v1 自 6.0+ 起提供）。
 * `rest-v2`  —— 官方新一代指南（手册第 1 章，官方 Agent 技能称之为 RESTful API v2.0）。
 *               目前只做**预留**：明确报 UNSUPPORTED，绝不假装支持。
 * `legacy-api` —— 传统 api.php；可选、不排期（保留以给出准确诊断）。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 */

import { CODES, ZenTaoError } from '../../domain/errors.js'
import { createRestV1Dialect } from './rest-v1.js'
import { legacyApiDialect } from './legacy-api.js'

/** rest-v2 预留占位：结构与 legacy 同形，但提示语不同。 */
export const restV2Dialect = {
  id: 'rest-v2',
  label: '禅道新一代 API（v2）',
  implemented: false,
  basePath: '',
  capabilities: {
    tokenAuth: true,
    serverFilters: false,
    paging: 'none',
    fieldFilter: false,
    relationExpand: false,
    myAggregate: false,
    effortApi: false,
    incremental: false,
    enterpriseEntities: false,
  },
  _notImplemented () {
    throw new ZenTaoError(
      CODES.UNSUPPORTED,
      '禅道新一代 API（手册第 1 章，官方称 RESTful API v2.0）尚未实现。' +
      '当前版本请使用 REST v1（dialect: rest-v1 或 auto）。',
    )
  },
  authHeaders () { this._notImplemented() },
  listSpec () { this._notImplemented() },
  detailSpec () { this._notImplemented() },
  writeSpec () { this._notImplemented() },
  meSpec () { this._notImplemented() },
  tokenSpec () { this._notImplemented() },
  parsePage () { this._notImplemented() },
  parseItem () { this._notImplemented() },
  parseError () {
    return new ZenTaoError(CODES.UNSUPPORTED, '禅道新一代 API（v2）尚未实现。')
  },
  webLink () { return undefined },
}

/** 全部已知方言 id（供 Config 的 union 与诊断用）。 */
export const DIALECT_IDS = Object.freeze(['auto', 'rest-v1', 'rest-v2', 'legacy-api'])

/** 探测梯的候选顺序（`auto` 时按此顺序尝试）。 */
export const PROBE_ORDER = Object.freeze(['rest-v1', 'rest-v2', 'legacy-api'])

/**
 * 取方言实现。
 * @param {string} id
 * @param {{ webLinkBase?: string }} [options]
 */
export function dialectOf (id, options = {}) {
  switch (id) {
    case 'rest-v1':
      return createRestV1Dialect(options)
    case 'rest-v2':
      return restV2Dialect
    case 'legacy-api':
      return legacyApiDialect
    default:
      throw new ZenTaoError(
        CODES.VALIDATION,
        `未知 dialect "${id}"。可用值：${DIALECT_IDS.join('、')}。`,
      )
  }
}
