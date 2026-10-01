/**
 * 注册模块解析钩子。配合 `node --import ./test/register-stub.mjs` 使用。
 */

import { register } from 'node:module'

register('./resolve-hook.mjs', import.meta.url)
