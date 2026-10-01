/**
 * 测试桩：把 `@deepseek-ai/*` 与 `zod` 映射到本文件。
 *
 * 目的不是模拟完整行为，而是：
 *   1. 让 `index.js` 及其装配层**真的能被 import 并 apply()**，从而抓住拼写错误、
 *      错误的导出名、错误的注册形状 —— 这些在真机上表现为"插件加载失败"，
 *      而在离线环境里本来无从发现；
 *   2. 把 `defineTool` 当**工具定义 linter** 用：形状不合法就抛错，
 *      于是"工具 schema 写错"会在测试里暴露，而不是在模型调用时才发现。
 *
 * 唯一的映射入口见 `resolve-hook.mjs`。
 */

import assert from 'node:assert/strict'

/* ───────────────────────── schemastery 桩 ───────────────────────── */

export class Schema {
  constructor (kind, extra = {}) {
    this.kind = kind
    this.fields = extra.fields
    this.list = extra.list
    this.items = extra.items
    this.value = extra.value
    this.meta = {}
    this.hasDefault = false
    this.defaultValue = undefined
  }

  default (value) { this.hasDefault = true; this.defaultValue = value; return this }
  description () { return this }
  role (role) { this.meta.role = role; return this }
  required () { this.meta.required = true; return this }
  volatile () { this.meta.volatile = true; return this }
  step () { return this }
  min () { return this }
  max () { return this }
  simplify (value) { return value }
}

const schemastery = {
  object: (fields) => new Schema('object', { fields }),
  string: () => new Schema('string'),
  number: () => new Schema('number'),
  boolean: () => new Schema('boolean'),
  array: (items) => new Schema('array', { items }),
  dict: (items) => new Schema('dict', { items }),
  tuple: (list) => new Schema('tuple', { list }),
  union: (list) => new Schema('union', { list }),
  intersect: (list) => new Schema('intersect', { list }),
  const: (value) => new Schema('const', { value }),
  any: () => new Schema('any'),
  never: () => new Schema('never'),
  is: () => new Schema('any'),
  transform: (inner) => new Schema('transform', { items: inner }),
  from: (value) => (value === undefined ? new Schema('any') : new Schema('const', { value })),
}

export default schemastery

/**
 * 把声明出来的 Config 物化成 `apply(ctx, config)` 需要的样子：
 * volatile 字段变成带 `.get()` 的活引用（与真实 schemastery 语义一致）。
 */
export function materializeConfig (schema, overrides = {}) {
  const out = {}
  for (const [key, field] of Object.entries(schema.fields ?? {})) {
    const fallback = field.hasDefault ? field.defaultValue : undefined
    const value = overrides[key] !== undefined ? overrides[key] : fallback
    out[key] = field.meta.volatile ? { get: () => value, __field: field } : value
  }
  return out
}

/* ─────────────────────────── zod 桩 ─────────────────────────── */

class ZodStub {
  constructor (kind) { this.kind = kind; this.shape = undefined }
  optional () { this.isOptional = true; return this }
  strict () { return this }
  passthrough () { return this }
}

export const z = {
  object: (shape) => { const s = new ZodStub('object'); s.shape = shape; return s },
  string: () => new ZodStub('string'),
  number: () => new ZodStub('number'),
  boolean: () => new ZodStub('boolean'),
  array: (items) => { const s = new ZodStub('array'); s.shape = items; return s },
  any: () => new ZodStub('any'),
  record: (items) => { const s = new ZodStub('record'); s.shape = items; return s },
  literal: () => new ZodStub('literal'),
  enum: () => new ZodStub('enum'),
  union: () => new ZodStub('union'),
}

/* ──────────────────────── dsh-tools 桩 ──────────────────────── */

/** 工具定义 linter：形状不合法直接抛错，等于把 schema 错误变成测试失败。 */
export function defineTool (definition) {
  assert.ok(definition && typeof definition === 'object', 'defineTool 需要定义对象')
  assert.equal(typeof definition.name, 'string', '工具必须有 name')
  assert.match(definition.name, /^[a-z][a-z0-9_]*$/, `工具名必须是纯小写 ASCII：${definition.name}`)
  assert.equal(typeof definition.description, 'string', `${definition.name} 必须有 description`)
  assert.ok(definition.description.length > 20, `${definition.name} 的 description 太短，模型看不出怎么用`)
  assert.equal(typeof definition.execute, 'function', `${definition.name} 必须有 execute`)

  const params = definition.parameters ?? {}
  for (const [key, spec] of Object.entries(params)) {
    assert.match(key, /^[a-z][a-zA-Z0-9_]*$/, `${definition.name} 的参数名必须 ASCII：${key}`)
    assert.equal(typeof spec?.type, 'string', `${definition.name}.${key} 缺少 type`)
    const allowed = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json', 'oneOf']
    assert.ok(allowed.includes(spec.type), `${definition.name}.${key} 的 type 不在 DSL 支持范围内：${spec.type}`)
    if (spec.enum !== undefined) {
      assert.ok(Array.isArray(spec.enum) && spec.enum.length > 0, `${definition.name}.${key} 的 enum 必须是非空数组`)
      for (const value of spec.enum) {
        // D3：enum **取值**必须保持 ASCII，中文只出现在 description 里
        assert.match(String(value), /^[\x20-\x7e]+$/, `${definition.name}.${key} 的 enum 取值必须是 ASCII：${value}`)
      }
    }
    if (spec.type === 'array') assert.ok(spec.items, `${definition.name}.${key} 是数组但没有 items`)
    if (spec.type === 'object') assert.ok(spec.properties || spec.additionalProperties !== undefined, `${definition.name}.${key} 是对象但没有 properties`)
  }

  const output = definition.output
  assert.ok(output && typeof output === 'object', `${definition.name} 必须有 output`)
  assert.equal(typeof output.render, 'function', `${definition.name}.output.render 必须是函数`)
  assert.ok(output.schema && typeof output.schema === 'object', `${definition.name}.output.schema 必须是对象`)

  return definition
}

/* ───────────────────── dsh-credentials 桩 ───────────────────── */

export function credentialRef (name) {
  assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, `凭据引用名必须是 POSIX 标识符：${name}`)
  // 真实实现：`brandString(value)`，而 brandString 就是 `return value`（品牌只在类型层面）。
  // 因此必须返回**原样字符串** —— 桩与真机在"按值比较"上不能分叉。
  return name
}

export function credentialKey (owner, id) {
  assert.ok(owner && id, 'credentialKey 需要 owner 与 id')
  // 真实实现：`brandString(`${scope}/${id}`)` → 原样字符串。
  // 这个形状很关键：授权服务按值查 flow（`const { key } = request; this.flows.get(key)`），
  // 桩若返回对象就会按引用比较，真机行为不同 —— 我为这个差异踩过一次 NO_FLOW。
  return `${owner}/${id}`
}

/* ──────────────────── dsh-storage-domain 桩 ──────────────────── */

const DOMAIN_NAME_RE = /^[a-z][a-z0-9-]*$/

export function defineDomain (spec) {
  assert.ok(spec && typeof spec === 'object', 'defineDomain 需要 spec')
  assert.match(spec.name, DOMAIN_NAME_RE, `domain 名不合法：${spec.name}`)
  assert.ok(Number.isInteger(spec.version) && spec.version >= 0, 'domain version 必须是非负整数')
  assert.ok(spec.tables && Object.keys(spec.tables).length > 0, 'domain 必须至少有一张表')
  return spec
}

export function domainTable (schema) {
  assert.ok(schema, 'domainTable 需要记录 schema')
  return { schema }
}
