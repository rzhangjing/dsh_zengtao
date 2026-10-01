/**
 * 把 `@deepseek-ai/*` 与第三方依赖解析到**真实包**（由 `DSH_REAL_MODULES` 指向抽取目录）。
 *
 * 用途：`test/real-contract.test.mjs` 用它拿真实校验器去撞本插件的真实定义，
 * 从而在没有 dsh 安装、也不改 profile 的前提下回答："这些定义拿到真机会不会加载失败？"
 *
 * 入口按**各包自己的 package.json** 定位（exports['.'] → import/module → main），
 * 而不是猜 `lib/index.js` —— 例如 schemastery 的真实入口是 `lib/index.mjs`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_REAL_MODULES

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 从 exports 值里取出 ESM 入口。 */
function pickExport (value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.import ?? value.module ?? value.default ?? undefined
  return undefined
}

/** 定位一个抽取包的入口（sub 为子路径，可省略）。 */
function entryFor (pkgDir, sub) {
  const pkg = readJson(path.join(pkgDir, 'package.json'))
  if (sub) {
    const dotted = pkg?.exports?.[`./${sub}`] ?? pkg?.exports?.[`./${sub}.js`]
    const fromExports = pickExport(dotted)
    if (fromExports) {
      const file = path.join(pkgDir, fromExports)
      if (fs.existsSync(file)) return file
    }
    for (const candidate of [`lib/${sub}.js`, `lib/${sub}.mjs`, `lib/${sub}/index.js`, `${sub}.js`]) {
      const file = path.join(pkgDir, candidate)
      if (fs.existsSync(file)) return file
    }
    return undefined
  }
  const fromExports = pickExport(pkg?.exports?.['.'])
  const candidates = [
    fromExports,
    pkg?.module,
    pkg?.main,
    'lib/index.mjs',
    'lib/index.js',
    'index.mjs',
    'index.js',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const file = path.join(pkgDir, candidate)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

export async function resolve (specifier, context, nextResolve) {
  if (ROOT) {
    const match = /^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/(.+))?$/.exec(specifier)
    if (match) {
      const [, pkgName, sub] = match
      const pkgDir = path.join(ROOT, 'node_modules', pkgName)
      if (fs.existsSync(pkgDir)) {
        const file = entryFor(pkgDir, sub)
        if (file) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}
