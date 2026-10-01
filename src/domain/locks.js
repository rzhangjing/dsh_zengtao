/**
 * 写操作的并发保护：同一对象串行、不同对象并行。
 *
 * 设计依据：design/02-detailed-design.md §9.3 ①。
 * 为什么必需：D7 决定允许子代理调用写工具，而子代理是并行执行的，
 * 因此"两个写者抢着改同一个 Bug"必须变成排队，而不是后写覆盖先写。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 */

/**
 * 键控串行队列。每个 key 一条独立的 promise 链，链尾无论成败都继续
 * （否则一次失败会把该 key 永久堵死）。
 */
export class KeyedQueue {
  constructor () {
    /** @type {Map<string, Promise<unknown>>} */
    this.tails = new Map()
    this.running = 0
  }

  /**
   * 在 `key` 的串行队列上执行 `fn`。
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run (key, fn) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    this.running += 1
    const settled = previous.then(
      () => fn(),
      () => fn(),
    )
    const tail = settled.then(
      () => {},
      () => {},
    ).finally(() => {
      this.running -= 1
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    this.tails.set(key, tail)
    return settled
  }

  /** 当前被占用的 key 数量（测试与诊断用）。 */
  get pendingKeys () {
    return this.tails.size
  }

  /** 是否还有未完成的排队项。 */
  get busy () {
    return this.running > 0
  }

  /**
   * 等待全部队列排空（测试用）。返回时队列必为空。
   */
  async drain () {
    // 队列可能在等待期间又追加新项，故循环到稳定为止。
    for (let guard = 0; guard < 1000; guard += 1) {
      const tails = [...this.tails.values()]
      if (tails.length === 0) return
      await Promise.allSettled(tails)
    }
  }
}

/** 组合键：`entity:id`。id 为 falsy 时退化成 `entity:new`（并发创建不做串行化）。 */
export function objectKey (entity, id) {
  return `${entity}:${id === undefined || id === null || id === '' ? 'new' : id}`
}

/* ─────────────────────── 乐观并发校验 ─────────────────────── */

/**
 * 比较读到的版本与写入前的预期。禅道 v1 载荷带 `version` 字段（已实证）。
 * 任一侧缺失时不阻断（返回 ok），因为老版本可能不返回 version；
 * 这时依赖同对象串行化 + 写后回读兜底。
 *
 * @returns {{ ok: boolean, expected?: unknown, actual?: unknown }}
 */
export function checkVersion (expected, actual) {
  if (expected === undefined || expected === null) return { ok: true }
  if (actual === undefined || actual === null) return { ok: true }
  const normalize = (v) => String(v)
  const ok = normalize(expected) === normalize(actual)
  return ok ? { ok: true } : { ok: false, expected, actual }
}
