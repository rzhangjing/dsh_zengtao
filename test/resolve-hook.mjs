/**
 * 把随 dsh 安装的包解析到测试桩，使装配层（index.js / tools.js / config.js / store.js）
 * 能在没有任何 dsh 安装的环境里被真正 import 并 apply()。
 *
 * 用法：`node --import ./test/register-stub.mjs --test test/*.test.js`
 */

const STUB = new URL('./stubs/dsh.mjs', import.meta.url).href

const MAPPED = new Set([
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-storage-domain',
  'zod',
])

export async function resolve (specifier, context, nextResolve) {
  if (MAPPED.has(specifier)) {
    return { url: STUB, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
