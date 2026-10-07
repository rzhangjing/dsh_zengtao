/**
 * 站点地址规范化测试。
 *
 * 背景（真机遇到）：用户从浏览器地址栏复制地址，于是配置里是
 * `http://127.0.0.1/zentao/my.html` —— 直接拼 API 会得到
 * `http://127.0.0.1/zentao/my.html/api.php/v1/...`，**必然失败**，
 * 而报错内容不会指出是这个原因。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { baseURLWasRewritten, normalizeBaseURL } from '../src/domain/url.js'
import { snapshotConfig } from '../src/config.js'

test('normalizeBaseURL：浏览器页面地址被裁成站点根（真机遇到的那个）', () => {
  assert.equal(normalizeBaseURL('http://127.0.0.1/zentao/my.html'), 'http://127.0.0.1/zentao')
  assert.equal(normalizeBaseURL('http://127.0.0.1/zentao/product-view-1.html'), 'http://127.0.0.1/zentao')
  assert.equal(normalizeBaseURL('http://127.0.0.1/zentao/index.php?m=my&f=index'), 'http://127.0.0.1/zentao')
  assert.equal(normalizeBaseURL('http://127.0.0.1/zentao/index.php/my.html'), 'http://127.0.0.1/zentao')
})

test('normalizeBaseURL：结尾斜杠、query、hash 都去掉', () => {
  assert.equal(normalizeBaseURL('https://zentao.example.com/'), 'https://zentao.example.com')
  assert.equal(normalizeBaseURL('https://zentao.example.com///'), 'https://zentao.example.com')
  assert.equal(normalizeBaseURL('https://zt.example.com/zentao/?x=1#y'), 'https://zt.example.com/zentao')
  assert.equal(normalizeBaseURL('  https://zt.example.com/zentao/  '), 'https://zt.example.com/zentao')
})

test('normalizeBaseURL：**不能误伤真实子目录**', () => {
  // 子目录必须保留 —— 这是最常见的企业部署形态
  assert.equal(normalizeBaseURL('https://host/zentao'), 'https://host/zentao')
  assert.equal(normalizeBaseURL('https://host/a/b/zentao'), 'https://host/a/b/zentao')
  // 名字里带 html 字样但不是页面文件，也不能裁
  assert.equal(normalizeBaseURL('https://host/html'), 'https://host/html')
  assert.equal(normalizeBaseURL('https://host/zentao.htmlx'), 'https://host/zentao.htmlx')
})

test('normalizeBaseURL：缺协议头时补 http://', () => {
  assert.equal(normalizeBaseURL('127.0.0.1/zentao'), 'http://127.0.0.1/zentao')
  assert.equal(normalizeBaseURL('zentao.example.com'), 'http://zentao.example.com')
})

test('normalizeBaseURL：空值与非字符串不炸', () => {
  assert.equal(normalizeBaseURL(''), '')
  assert.equal(normalizeBaseURL(undefined), '')
  assert.equal(normalizeBaseURL(null), '')
  assert.equal(normalizeBaseURL('   '), '')
})

test('baseURLWasRewritten：只有真的改过才为 true（用于诊断提示）', () => {
  assert.equal(baseURLWasRewritten('http://127.0.0.1/zentao/my.html'), true)
  assert.equal(baseURLWasRewritten('http://127.0.0.1/zentao'), false)
  assert.equal(baseURLWasRewritten(''), false)
})

test('配置快照：baseURL 已被规范化（所有消费者看到同一个干净地址）', () => {
  // 用普通对象即可：snapshotConfig 的 value() 同时兼容"volatile 活引用"与普通值。
  // （不在这里调 Config(...)：离线套件的 schemastery 是桩，不是可调用的 schema —— 真实
  //   schemastery 的行为由真实包契约测试覆盖。）
  const snapshot = snapshotConfig({
    baseURL: 'http://127.0.0.1/zentao/my.html',
    dialect: 'rest-v1',
  })
  assert.equal(snapshot.baseURL, 'http://127.0.0.1/zentao',
    '请求、网页链接、探测都读这个快照，所以必须在源头就干净')
})
