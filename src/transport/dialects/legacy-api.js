/**
 * 方言 B：传统 `api.php?m=&f=&t=json` + `zentaosid` Cookie。
 *
 * 状态：**可选、不排期**（D1 已定企业版，REST v1 自企业版 6.0+ 起提供）。
 * 保留这个适配器而不是删掉，是为了让探测梯的 404 分支能给出**准确的诊断**：
 * 用户会看到"REST v1 不可用，且传统接口适配器尚未实现"，而不是一个含糊的失败。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 */

import { CODES, ZenTaoError } from '../../domain/errors.js'

const NOT_IMPLEMENTED = '传统 api.php 方言（m/f/t + zentaosid Cookie）尚未实现。' +
  '目标版本是企业版，REST v1 自企业版 6.0+ 起提供，请先确认 baseURL 与接口是否开启；' +
  '若确实需要对接老版本，请在路径上手工指定 dialect 并反馈，我们再排期。'

function notImplemented () {
  throw new ZenTaoError(CODES.UNSUPPORTED, NOT_IMPLEMENTED)
}

export const legacyApiDialect = {
  id: 'legacy-api',
  label: '传统 api.php 接口',
  implemented: false,
  basePath: '',
  capabilities: {
    tokenAuth: false,
    serverFilters: false,
    paging: 'none',
    fieldFilter: false,
    relationExpand: false,
    myAggregate: false,
    effortApi: false,
    incremental: false,
    enterpriseEntities: false,
  },
  authHeaders () {
    notImplemented()
  },
  listSpec () {
    notImplemented()
  },
  detailSpec () {
    notImplemented()
  },
  writeSpec () {
    notImplemented()
  },
  meSpec () {
    notImplemented()
  },
  tokenSpec () {
    notImplemented()
  },
  parsePage () {
    notImplemented()
  },
  parseItem () {
    notImplemented()
  },
  parseError (response) {
    return ZenTaoError.prototype.isPrototypeOf(response)
      ? response
      : new ZenTaoError(CODES.UNSUPPORTED, NOT_IMPLEMENTED)
  },
  webLink () {
    return undefined
  },
}
