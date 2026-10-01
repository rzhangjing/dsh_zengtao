/**
 * 写入策略决策矩阵（design §9.1 的决策表逐格验证）。
 * 这是"确认门禁"的核心：策略错了就是"该问的没问"或"该放的拦住"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyCall, decideWrite, denyReason, renderIntent } from '../src/domain/policy.js'

const POLICY_CASES = [
  // [action, policy, 期望]
  ['create', 'readonly', 'deny'], ['create', 'confirm', 'ask'], ['create', 'trusted', 'allow'],
  ['update', 'readonly', 'deny'], ['update', 'confirm', 'ask'], ['update', 'trusted', 'allow'],
  ['start', 'readonly', 'deny'], ['start', 'confirm', 'ask'], ['start', 'trusted', 'allow'],
  ['finish', 'readonly', 'deny'], ['finish', 'confirm', 'ask'], ['finish', 'trusted', 'allow'],
  ['comment', 'readonly', 'deny'], ['comment', 'confirm', 'ask'], ['comment', 'trusted', 'allow'],
  ['resolve', 'readonly', 'deny'], ['resolve', 'confirm', 'ask'], ['resolve', 'trusted', 'allow'],
  // 删除类：trusted 也必须问
  ['delete', 'readonly', 'deny'], ['delete', 'confirm', 'ask'], ['delete', 'trusted', 'ask'],
]

for (const [action, policy, expected] of POLICY_CASES) {
  test(`决策：${action} × ${policy} → ${expected}`, () => {
    const cls = classifyCall('zentao_write', { action, entity: 'task', id: '1', dryRun: false })
    assert.equal(decideWrite(policy, cls), expected)
  })
}

test('dryRun 在任何策略下都放行（它不写任何东西）', () => {
  for (const policy of ['readonly', 'confirm', 'trusted']) {
    const cls = classifyCall('zentao_write', { action: 'delete', entity: 'bug', id: '1' })
    assert.equal(cls.dryRun, true, '缺省即 dryRun')
    assert.equal(decideWrite(policy, cls), 'allow')
    assert.equal(decideWrite(policy, classifyCall('zentao_write', { action: 'delete', entity: 'bug', id: '1', dryRun: true })), 'allow')
  }
})

test('批量（>1 项）在 confirm 与 trusted 下都要问', () => {
  const bulk = [{ id: '1' }, { id: '2' }]
  for (const policy of ['readonly', 'confirm', 'trusted']) {
    const cls = classifyCall('zentao_write', { action: 'update', entity: 'task', bulk, dryRun: false })
    assert.equal(cls.isBulk, true)
    assert.equal(cls.bulkCount, 2)
    const expected = policy === 'readonly' ? 'deny' : 'ask'
    assert.equal(decideWrite(policy, cls), expected)
  }
})

test('单项 bulk 不算批量', () => {
  const cls = classifyCall('zentao_write', { action: 'update', entity: 'task', bulk: [{ id: '1' }], dryRun: false })
  assert.equal(cls.isBulk, false)
  assert.equal(decideWrite('trusted', cls), 'allow')
})

test('非本门禁管辖的工具一律放行（返回 null 表示交给下游）', () => {
  assert.equal(decideWrite('readonly', classifyCall('zentao_query', { entity: 'bug' })), null)
  assert.equal(classifyCall('zentao_query', {}).isWrite, false)
  assert.equal(decideWrite('readonly', classifyCall('read_file', { path: '/x' })), null)
})

test('拒绝理由包含策略名与开启方法（模型能照着做）', () => {
  const reason = denyReason('readonly')
  assert.match(reason, /readonly/)
  assert.match(reason, /confirm 或 trusted/)
})

test('确认摘要说清"将改什么"，而不是复述 JSON', () => {
  const cls = classifyCall('zentao_write', {
    action: 'update', entity: 'bug', id: '4821', dryRun: false,
    payload: { patch: { status: 'resolved', pri: 1 } },
  })
  const text = renderIntent(cls, {
    action: 'update', entity: 'bug', id: '4821', payload: { patch: { status: 'resolved', pri: 1 } },
  })
  assert.match(text, /修改/)
  assert.match(text, /bug #4821/)
  assert.match(text, /status=resolved/)
  assert.match(text, /pri=1/)
})

test('删除类的摘要带上警示，批量带条数', () => {
  const del = classifyCall('zentao_write', { action: 'delete', entity: 'bug', id: '9', dryRun: false })
  assert.match(renderIntent(del, {}), /删除/)
  const bulk = classifyCall('zentao_write', { action: 'close', entity: 'task', bulk: [{ id: '1' }, { id: '2' }], dryRun: false })
  assert.match(renderIntent(bulk, {}), /批量 2 项/)
})
