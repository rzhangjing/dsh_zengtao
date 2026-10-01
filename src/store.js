/**
 * 持久状态。
 *
 * 设计取舍（与设计稿 §6 的一处有意偏离，理由如下）：
 *   设计稿列了 probe / entities / cursors / idempotency 四张表，并计划从 domain
 *   读回全部记录。但 `dsh-storage-domain` 的**批量列举 API 未在手册中核验**
 *   （README 只演示了 get / put / update / delete）。为了不依赖未核验的能力，
 *   这里改成：
 *     - `probe`：**按 key 读回**（`get('current')`），因此它是真正持久的 ——
 *       重启后不必重新探测；这也是唯一有跨重启价值的记录。
 *     - `entities` / `idempotency`：纯**进程内**缓存（短 TTL：详情缓存与 5 分钟
 *       幂等窗口），并做**尽力而为**的写穿透（不读回）。
 *     - `cursors`：增量同步属 P3，暂不建表。
 *   这样既拿到了持久化的实际收益，又不引入未核验的依赖。
 *
 * 另一个取舍：storage domain 缺失时**降级为纯内存**并如实报告，而不是抛错。
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 记录 schema（zod，由 storage domain 在持久化边界校验）。 */
const probeRecord = z.object({
  baseURL: z.string(),
  dialectId: z.string(),
  dialectLabel: z.string(),
  probedAt: z.string(),
  version: z.string().optional(),
  probeVersion: z.number(),
  facts: z.array(z.any()).optional(),
})

const entityRecord = z.object({
  at: z.number(),
  item: z.any(),
})

const idempotencyRecord = z.object({
  at: z.number(),
  resultRef: z.string().optional(),
})

export const zentaoDomain = defineDomain({
  name: 'zentao',
  version: 1,
  // 一条坏记录**不能**让整个域打不开：开域时会用下面的 zod schema 校验每条已存记录，
  // 默认策略是校验失败就抛错 —— 那会因为一条过期的探测缓存而**整体丢掉持久化**
  // （包括幂等窗口）。这个策略让坏记录被备份并跳过。
  invalidRecords: 'backup-and-skip',
  tables: {
    probe: domainTable(probeRecord),
    entities: domainTable(entityRecord),
    idempotency: domainTable(idempotencyRecord),
  },
})

/** 内存缓存上限：超出后按写入时间淘汰最旧的一批（缓存不是真相）。 */
const MAX_ENTITY_CACHE = 500

/**
 * @param {object} ctx  Cordis 上下文（用 ctx.get('storageDomain') 惰性取服务）
 * @param {(msg: string) => void} [logger]
 */
export function createStore (ctx, logger) {
  const memory = {
    probe: undefined,
    entities: new Map(),
    idempotency: new Map(),
  }
  let domainPromise
  /** 降级原因：让 `/zentao doctor` 能说清"为什么没有持久化"，而不是只有一行日志。 */
  let degradeReason

  /** 惰性打开 domain：只在第一次真正需要持久化时打开一次。 */
  function getDomain () {
    if (domainPromise === undefined) {
      domainPromise = (async () => {
        const storageDomain = ctx.get('storageDomain')
        if (!storageDomain) {
          degradeReason = 'Host 未提供 storageDomain 服务'
          return undefined
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await storageDomain.open(zentaoDomain)
          } catch (error) {
            const message = String(error?.message ?? error)
            // 同名域已被占用：通常是上一个实例的 close 还在飞行中（重载竞态）。
            // 等一拍重试一次，不要把一次竞态降级成"永久只用内存"。
            // 判定优先看稳定的 `code`：真实实现是 DomainError('already-open', "domain 'x' is already open")，
            // 消息是给人看的（带空格），拿它当主判据会漏掉。
            const alreadyOpen = error?.code === 'already-open' || /already[- ]open/i.test(message)
            if (attempt === 0 && alreadyOpen) {
              await new Promise((resolve) => setTimeout(resolve, 50))
              continue
            }
            degradeReason = `打开 storage domain 失败：${message}`
            logger?.(`禅道插件：${degradeReason}，降级为纯内存缓存`)
            return undefined
          }
        }
        return undefined
      })()
    }
    return domainPromise
  }

  async function persist (table, id, record) {
    const domain = await getDomain()
    if (!domain) return
    try {
      await domain.table(table).put(id, record)
    } catch (error) {
      logger?.(`禅道插件：写入 ${table}/${id} 失败（${error?.message ?? error}）`)
    }
  }

  function pruneEntities () {
    if (memory.entities.size <= MAX_ENTITY_CACHE) return
    const entries = [...memory.entities.entries()].sort((a, b) => a[1].at - b[1].at)
    const excess = memory.entities.size - MAX_ENTITY_CACHE
    for (let i = 0; i < excess; i += 1) memory.entities.delete(entries[i][0])
  }

  return {
    /** 探测结论：唯一跨重启持久的记录。 */
    async getProbe () {
      if (memory.probe !== undefined) return memory.probe
      const domain = await getDomain()
      if (!domain) return undefined
      try {
        const record = domain.table('probe').get('current')
        if (record) memory.probe = record
        return memory.probe
      } catch (error) {
        logger?.(`禅道插件：读取探测缓存失败（${error?.message ?? error}）`)
        return undefined
      }
    },

    async setProbe (record) {
      memory.probe = record
      await persist('probe', 'current', record)
      return record
    },

    async getEntity (entity, id) {
      return memory.entities.get(`${entity}:${id}`)
    },

    async setEntity (entity, id, record) {
      memory.entities.set(`${entity}:${id}`, record)
      pruneEntities()
      await persist('entities', `${entity}:${id}`, record)
      return record
    },

    /**
     * 幂等记录：**读穿透到持久层**。
     *
     * 为什么值得持久化：幂等键是"别把同一次写重复落库"的保护。原来它只有进程内 Map，
     * 于是重启（或插件重载）后 5 分钟窗口内的重放会被当成新写 → **重复落库**。
     * 现在按 key 读回，窗口跨重启依然有效。
     */
    async getIdempotency (key) {
      const cached = memory.idempotency.get(key)
      if (cached !== undefined) return cached
      const domain = await getDomain()
      if (!domain) return undefined
      try {
        const record = domain.table('idempotency').get(key)
        if (record !== undefined) memory.idempotency.set(key, record)
        return record
      } catch (error) {
        logger?.(`禅道插件：读取幂等记录 ${key} 失败（${error?.message ?? error}）`)
        return undefined
      }
    },

    async setIdempotency (key, record) {
      memory.idempotency.set(key, record)
      // 顺手清理过期项，避免内存里无限累积
      const cutoff = Date.now() - 60 * 60 * 1000
      for (const [existingKey, value] of memory.idempotency) {
        if (value.at < cutoff) memory.idempotency.delete(existingKey)
      }
      await persist('idempotency', key, record)
      return record
    },

    /** 持久化状态与**降级原因**（`/zentao doctor` 用它把"为什么没持久化"说清楚）。 */
    async storageStatus () {
      const domain = await getDomain()
      if (domain) return { mode: 'storage-domain' }
      return { mode: 'memory-only', reason: degradeReason ?? '未知原因' }
    },

    async close () {
      const domain = await getDomain()
      try {
        await domain?.close?.()
      } catch (error) {
        logger?.(`禅道插件：关闭 storage domain 失败（${error?.message ?? error}）`)
      }
    },
  }
}
