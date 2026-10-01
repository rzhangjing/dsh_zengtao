/**
 * 可安装性（manifest）验收测试。
 *
 * 为什么需要：我无法在这个环境里真正 `install_bundle`（那会改用户的 profile），
 * 但"装上去立刻坏"的原因几乎都是清单层面的 —— exports 指向不存在的文件、
 * `files` 漏了某个源码目录（安装后运行时缺模块）、示例 config 与 Config schema 漂移、
 * icon 超限或被拒绝、locale 文件形状不对。这些**全都能离线检查**，而且是发布前最值得检查的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { Config } from '../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

const pkg = readJson('package.json')

/** 把 glob 转成正则（只需支持本清单里用到的 `**`、`*`、`?`）。 */
function globToRegExp (pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(rel, out)
    } else {
      out.push(rel)
    }
  }
  return out
}

/* ─────────────── 清单基本形状 ─────────────── */

test('manifest：必需字段齐备且形状正确', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.match(pkg.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/, `包名应为 scoped 形式：${pkg.name}`)
  assert.equal(pkg.type, 'module', 'Host 半是 ESM，必须有 type: module')
  assert.equal(pkg.private, true)
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
  assert.equal(typeof pkg.description, 'string')
  assert.ok(pkg.description.length > 10)
})

test('manifest：dsh.bundle.patch 存在且指向真实补丁文件', () => {
  const patch = pkg.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string', 'bundle 必须声明 patch')
  assert.ok(exists(patch), `patch 文件不存在：${patch}`)

  const text = fs.readFileSync(path.join(ROOT, patch), 'utf8')
  assert.match(text, /^- insert:/m, '补丁必须是 insert 行（当前 profile 根为空，靠 insert 挂载）')
  assert.match(text, /id:\s*zentao\b/, '补丁里的行 id 应为 zentao')
  assert.ok(text.includes(pkg.name), `补丁的 name 必须等于包名 ${pkg.name}`)
})

test('manifest：dsh.client 声明为 web 面，inject 只列包名', () => {
  const client = pkg.dsh?.client
  assert.ok(client, '必须声明 dsh.client（否则浏览器半不会被加载）')
  assert.equal(client.platform, 'web')
  assert.ok(Array.isArray(client.inject))
  for (const name of client.inject) {
    assert.match(name, /^@deepseek-ai\//, `inject 里应是包名：${name}`)
  }
})

/* ─────────────── exports 与 files ─────────────── */

test('manifest：每个 exports 目标都在磁盘上存在', () => {
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : value?.default
    assert.equal(typeof target, 'string', `exports["${key}"] 应是字符串或 {default}`)
    assert.ok(!path.isAbsolute(target), `exports 不能用绝对路径：${target}`)
    assert.ok(!target.includes('..'), `exports 不能越出包目录：${target}`)
    if (target.includes('*')) continue // 通配导出（如 locale/*.json）另行校验
    assert.ok(exists(target), `exports["${key}"] 指向不存在的文件：${target}`)
  }
  assert.ok(pkg.exports['.'], '必须有根导出')
  assert.ok(pkg.exports['./client'], '必须有 ./client 导出（浏览器半入口）')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
})

test('manifest：files 覆盖**全部**源码与资源（漏一个目录 = 安装后运行期缺模块）', () => {
  const patterns = (pkg.files ?? []).map(globToRegExp)
  assert.ok(patterns.length > 0, '必须声明 files')

  const required = [
    'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg',
    ...walk('src'),
    ...walk('locale'),
  ]
  const missing = required.filter((rel) => !patterns.some((re) => re.test(rel)))
  assert.deepEqual(missing, [], `这些文件不会被安装进去：${missing.join(', ')}`)
})

test('manifest：files 里不该混进测试、设计文档或缓存', () => {
  const patterns = (pkg.files ?? []).map(globToRegExp)
  for (const rel of ['test/assembly.test.js', 'design/01-framework.md', 'README.md', 'package.json']) {
    assert.ok(!patterns.some((re) => re.test(rel)), `${rel} 不该被 files 匹配（避免装进无关内容）`)
  }
})

/* ─────────────── 补丁形状：insert 必须是**序列** ─────────────── */

test('manifest：补丁的 insert 必须是 YAML **序列**（写成单个映射会让真实 loader 抛错）', () => {
  const text = fs.readFileSync(path.join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  const lines = text.split(/\r?\n/)

  assert.ok(!lines.some((line) => line.includes('\t')), 'YAML 缩进不能用制表符')

  const insertIndex = lines.findIndex((line) => /^(\s*)- insert:\s*$/.test(line))
  assert.ok(insertIndex >= 0, '必须有一行 `- insert:`')
  const insertIndent = lines[insertIndex].match(/^\s*/)[0].length

  // 紧随其后的第一个有效行必须是**序列项**（`- `）且缩进更深。
  // 依据（已核验的真实实现 dsh-app-boot/lib/index.js:87）：
  //   `else data.push(...insert);` —— insert 会被**展开**，而展开要求可迭代。
  // 若 insert 是单个映射，这行会抛 `TypeError: Spread syntax requires ...iterable`，
  // 于是 DSH 的配置组装直接失败（安装即坏）。
  const rest = lines.slice(insertIndex + 1)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  assert.ok(rest.length > 0, 'insert 不能是空的')
  const nextIndent = rest[0].match(/^\s*/)[0].length
  assert.ok(nextIndent > insertIndent, `insert 的子项必须缩进更深（${nextIndent} vs ${insertIndent}）`)
  assert.match(rest[0], /^\s*- /, 'insert 后面必须是序列（`- id: …`），不能是单个映射')

  // 序列项块：从第一项起、缩进不小于它的所有有效行
  const itemIndent = nextIndent
  const itemBlock = []
  for (const line of rest) {
    const indent = line.match(/^\s*/)[0].length
    if (indent < itemIndent) break
    itemBlock.push(line)
  }
  assert.ok(itemBlock.some((line) => /^\s*-?\s*id:\s*\S+/.test(line)), '序列项必须有 id')
  assert.ok(itemBlock.some((line) => line.includes(pkg.name)), `序列项的 name 必须包含包名 ${pkg.name}`)
  assert.ok(itemBlock.some((line) => /^\s*config:\s*$/.test(line)), '序列项必须带 config（示例配置）')
})

test('manifest：补丁文件必须通过 exports 可达（官方 bundle 都导出它）', () => {
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  const target = pkg.exports['./cordis.patch.yml']
  assert.ok(exists(target.replace(/^\.\//, '')), `exports 指向的补丁不存在：${target}`)
})

test('manifest：运行时用到的每个外部包都必须在 peerDependencies 里声明', () => {
  // **真机踩过的坑**：这一条缺失时离线测试全绿、`--dump-config` 也正常，
  // 但 DSH 真启动会打印 `zentao (@local/dsh-plugin-zentao): failed to import`
  // —— 因为 DSH 的 runtime resolution 只按**本包 package.json 里声明的 peer 名**把
  // `@deepseek-ai/*` 接到应用自带副本上（见 dsh-app-boot README「链接目录」一节）。
  // 我的测试夹具当时用自定义 hook 注入真实模块，所以完全掩盖了它。
  const files = ['index.js', 'client.js']
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) files.push(path.relative(ROOT, full).replace(/\\/g, '/'))
    }
  }
  walk(path.join(ROOT, 'src'))

  const externals = new Set()
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const spec = match[1]
      if (spec.startsWith('@deepseek-ai/')) externals.add(spec.split('/').slice(0, 2).join('/'))
      else if (spec === 'zod' || spec.startsWith('zod/')) externals.add('zod')
    }
  }
  assert.ok(externals.size >= 5, `应当扫到若干运行时外部依赖，实际只扫到 ${[...externals].join(', ')}`)

  for (const name of externals) {
    assert.ok(pkg.peerDependencies?.[name] !== undefined,
      `运行时导入了 ${name}，但 package.json 的 peerDependencies 没声明它 —— 真机上会 failed to import`)
  }
  // DSH 自家包必须用 workspace: 范围：兼容性检查会把 workspace:^/~/* 映射成运行时版本
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      assert.match(range, /^workspace:/, `${name} 的 peer 范围应写成 workspace:^（否则兼容性检查会拿它跟运行时版本死比）`)
    }
  }
})

test('manifest：Plugins 页读元数据要用的资源能**按包名解析**到（真实 Node 解析 + exports）', () => {
  // 依据真实实现 dsh-app-boot 的 readPluginMeta：它读
  //   `<包>/locale/en.json`（经 exports 解析）与 `<包>/package.json`（含 icon/name/description），
  // 标题/描述来自 locale 字典的 meta。因此这些子路径**必须**在 exports 里可达。
  const simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-exports-'))
  const scope = path.join(simDir, 'node_modules', '@local')
  const linked = path.join(scope, 'dsh-plugin-zentao')
  fs.mkdirSync(scope, { recursive: true })
  fs.writeFileSync(path.join(simDir, 'package.json'), '{"name":"sim","private":true}')
  // 模拟 pnpm install 的产物：node_modules 里指向包目录的 junction
  fs.symlinkSync(ROOT, linked, 'junction')
  try {
    const anchored = path.join(simDir, 'package.json')
    const req = createRequire(anchored)
    for (const sub of ['package.json', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml']) {
      const specifier = `${pkg.name}/${sub}`
      const resolved = req.resolve(specifier)
      // Node 默认解析 symlink（preserveSymlinks=false），所以拿到的是真实路径
      assert.ok(resolved.startsWith(ROOT), `${specifier} 应解析到本包目录内，实际 ${resolved}`)
      assert.ok(fs.existsSync(resolved), `${specifier} 解析到的文件必须存在`)
    }
    // 主入口也要能解析（装载器会 import 它）
    assert.ok(req.resolve(pkg.name).startsWith(ROOT))
    // 未导出的子路径必须**解析失败**（exports 是白名单，不是摆设）
    assert.throws(() => req.resolve(`${pkg.name}/src/service.js`), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find/)
  } finally {
    // 安全清理：先只删 junction，确认删掉后才删临时目录
    try { fs.unlinkSync(linked) } catch { /* 已不存在 */ }
    if (!fs.existsSync(linked)) fs.rmSync(simDir, { recursive: true, force: true })
  }
})

/* ─────────────── 示例 config 与 Config schema ─────────────── */

test('manifest：补丁里的示例 config 必须与 Config schema 一致（防字段漂移）', () => {
  const text = fs.readFileSync(path.join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
  assert.ok(start >= 0, '补丁里应有示例 config')
  const configIndent = lines[start].match(/^\s*/)[0].length

  const keys = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= configIndent) break
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(line)
    if (match) keys.push(match[1])
  }
  assert.ok(keys.length > 0, '示例 config 应该至少有字段')

  const declared = Object.keys(Config.fields)
  for (const key of keys) {
    assert.ok(declared.includes(key), `示例 config 里的 "${key}" 在 Config 里不存在（字段漂移）`)
  }
  // 示例里必须给出站点地址，否则用户装完不知道该填什么
  assert.ok(keys.includes('baseURL'))
})

/* ─────────────── icon 与显示元数据 ─────────────── */

test('icon：相对路径、在白名单格式内、且小于 256KiB', () => {
  const icon = pkg.icon
  assert.equal(typeof icon, 'string', '应声明 icon')
  assert.ok(icon.startsWith('./'), `icon 必须是相对路径：${icon}`)
  assert.ok(!icon.includes('..'), 'icon 不能越出包目录')
  assert.ok(exists(icon), `icon 文件不存在：${icon}`)
  assert.match(icon, /\.(svg|png|jpe?g|webp)$/i, 'icon 只接受 svg/png/jpeg/webp')
  const size = fs.statSync(path.join(ROOT, icon)).size
  assert.ok(size > 0 && size < 256 * 1024, `icon 大小必须在 0..256KiB：${size}`)
  if (/\.svg$/i.test(icon)) {
    const svg = fs.readFileSync(path.join(ROOT, icon), 'utf8')
    assert.match(svg, /<svg[\s>]/, 'SVG 必须有 <svg> 根元素')
  }
})

test('meta：title 与 description 都有内容（插件卡片要显示它们）', () => {
  assert.equal(typeof pkg.meta?.title, 'string')
  assert.equal(typeof pkg.meta?.description, 'string')
  assert.ok(pkg.meta.title.trim().length > 0)
  assert.ok(pkg.meta.description.trim().length > 10)
})

test('locale：zh/en 两份都合法、字段一致，且中文那份确实是中文', () => {
  const zh = readJson('locale/zh.json')
  const en = readJson('locale/en.json')
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    assert.equal(typeof dict.meta?.title, 'string', `${name}.meta.title 缺失`)
    assert.equal(typeof dict.meta?.description, 'string', `${name}.meta.description 缺失`)
  }
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort(), '两份语言的字段必须一致')
  assert.match(zh.meta.title, /[\u4e00-\u9fa5]/, 'zh 的标题应含中文')
  assert.doesNotMatch(en.meta.title, /[\u4e00-\u9fa5]/, 'en 的标题不应是中文')
})

/* ─────────────── 目录卫生 ─────────────── */

test('仓库里不该留下调研缓存或调试脚本（会污染交付物）', () => {
  const entries = fs.readdirSync(ROOT)
  const junk = entries.filter((name) => name.startsWith('.zt_') || name === '_debug.mjs' || name.endsWith('.orig'))
  assert.deepEqual(junk, [], `发现残留物：${junk.join(', ')}`)
  assert.ok(!fs.existsSync(path.join(ROOT, '.zt_api_cache')), '调研缓存必须清掉')
})

test('交付文件不得带 UTF-8 BOM（Windows PowerShell 的 Set-Content 会偷偷加）', () => {
  // 这一条是被自己踩出来的：用 PS 5.1 的 Set-Content -Encoding UTF8 改 README，
  // 内容没坏但**开头多了一个 BOM**（ef bb bf）。BOM 会干扰工具链与 diff，所以钉死。
  const files = [
    'package.json', 'README.md', 'cordis.patch.yml', 'icon.svg', 'index.js', 'client.js',
    'locale/zh.json', 'locale/en.json', 'design/01-framework.md', 'design/02-detailed-design.md',
  ]
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(ROOT, rel))
    const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    assert.ok(!hasBom, `${rel} 带 UTF-8 BOM —— 请用 write/edit 工具改文件，别用 PowerShell 的 Set-Content`)
  }
})
