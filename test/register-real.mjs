/** 用真实包解析时注册钩子：`node --import ./test/register-real.mjs …` */

import { register } from 'node:module'

register('./real-resolve-hook.mjs', import.meta.url)
