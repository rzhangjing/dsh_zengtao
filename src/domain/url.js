/**
 * 站点地址规范化。
 *
 * 为什么需要：用户很自然会从**浏览器地址栏**复制地址，于是拿到的是页面 URL 而不是站点根：
 *   http://127.0.0.1/zentao/my.html        ← 真机遇到过的实际配置
 *   http://127.0.0.1/zentao/index.php?m=my&f=index
 *   https://zentao.example.com/
 * 如果不处理，请求就会拼成 `…/my.html/api.php/v1/...`（全错），而报错信息又不会指向这个原因。
 *
 * 规则（只做**保守**的裁剪，避免误伤真实子目录）：
 *   1. 去掉首尾空白；没有协议头时补 `http://`
 *   2. 丢掉 query 与 hash（页面 URL 常带 `?m=…&f=…`）
 *   3. 结尾是 `/index.php`（或 `index.php/…`）→ 去掉
 *   4. 最后一段以 `.html` 结尾（如 `my.html`、`product-view-1.html`）→ 去掉那一段
 *   5. 去掉结尾的 `/`
 * 子目录（`/zentao`）**不会**被去掉 —— 那是真实部署路径。
 *
 * 纯模块：不 import 任何 `@deepseek-ai/*`。
 */

/** 最后一段像禅道页面（`xxx.html`）吗。 */
const PAGE_SEGMENT = /\/[^/]*\.html?$/i
/** 结尾的 index.php（可能后面还有东西，如 index.php/zentao）。 */
const INDEX_PHP = /\/index\.php(?:\/.*)?$/i

/**
 * @param {unknown} raw 用户填写的地址
 * @returns {string} 规范化后的站点根地址（无法解析时返回裁剪后的原值）
 */
export function normalizeBaseURL (raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return ''

  // ② query / hash 一律丢掉
  const hashAt = text.indexOf('#')
  if (hashAt >= 0) text = text.slice(0, hashAt)
  const queryAt = text.indexOf('?')
  if (queryAt >= 0) text = text.slice(0, queryAt)

  // ① 缺协议头时补 http://（只补在"看起来像主机名"的情况下，避免把乱七八糟的输入变成奇怪的东西）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `http://${text.replace(/^\/+/, '')}`
  }

  // ③④⑤ 反复裁掉"页面尾巴"，直到稳定（同时处理 index.php 与 .html 两种形态）
  let previous
  do {
    previous = text
    text = text.replace(INDEX_PHP, '')
    text = text.replace(PAGE_SEGMENT, '')
    text = text.replace(/\/+$/, '')
  } while (text !== previous)

  return text
}

/**
 * 规范化是否改变了输入（诊断与提示用：告诉用户"我用的是这个地址"）。
 */
export function baseURLWasRewritten (raw) {
  const normalized = normalizeBaseURL(raw)
  return String(raw ?? '').trim() !== '' && normalized !== String(raw ?? '').trim()
}
