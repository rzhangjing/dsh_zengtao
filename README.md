# @local/dsh-plugin-zentao

DeepSeek Harness 的**禅道（ZenTao）企业版**插件。让 Agent 能查询禅道的产品 / 项目 / 执行(迭代) / 需求 / 任务 / Bug，并在**用户确认**的前提下受控写入。

- 目标版本：**禅道企业版**（REST v1 自企业版 6.0+ 起提供），**单站点**。
- 认证：**禅道账号 + 密码**（存在 DSH 凭据库里，配置文件里只有引用名）。插件用它们自动换取 API Token，Token 只在内存缓存。
- 写入：默认 `dryRun`（只回显将要发出的请求），真实写入由写入策略与用户确认把关。

---

## 交付状态与本机校准（先读这一段）

**代码与校准都已闭环；唯一没做的是"把它装进你的 DSH"这一步 —— 那需要你点一次（见下）。**

| 项目 | 状态 |
|---|---|
| Host 半 + Client 半实现 | ✅ 完成（5 个工具 / 1 个命令 + 7 子命令 / 1 个技能 / 提示词段 2 变量 / 会话投影 / 设置卡片 / 会话卡片 / 全屏看板 + 侧栏入口） |
| 全部源文件语法 | ✅ 48 个 JS/MJS 文件 `node --check` 通过 |
| 离线单元测试 | ✅ **342 项全绿**（`npm test`，不需要禅道） |
| 真实包契约测试 | ✅ **16 项全绿**（真实 schemastery/defineTool/defineDomain/zod、真实补丁与 profile 装载器、**真实 Cordis 框架**） |
| §7.6 六项待实测校准 | ✅ 全部有定论（4 项确证 / 1 项确证"参数不存在" / 1 项配置级取证），其中端点路径、网页深链、请求参数三项是**运行级实证** |
| §14.2 M1 / M2 / M4 / M6 | ✅ 达成（含**真机**幂等、并发冲突、写入回读、软删除证据） |
| §14.2 M5 | ✅ 已实现（会话卡片 + 全屏看板 + 侧栏入口）；**视觉待装载后确认** |
| §14.2 M3 | ✅ 代码级齐备（含"无硬编码颜色"不变量、"被拒绝不谎报已保存"）；**真实点击待装载后确认** |
| §14.2 M0 | ⏳ **只差装载**：打包/解析/兼容性检查/补丁层/组合/真框架加载/门禁生效/卸载清干净**都已被真实装载器与真实 Cordis 验证**，但"在你机器上真的启动"只有装一次才能证明 |

### 你需要做的那一步

1. Harness Web 侧栏 → **Plugins** 页 → 安装本目录（或让 Agent 调 `plugin_manager.install_bundle`，`target` 填本包绝对路径）；
2. 装好后在会话里执行 `/zentao doctor` —— 应看到方言（`rest-v1`）、命中端点、当前账号、持久化状态与**未校准清单只剩 `comment`**；
3. 在设置页填 `baseURL`（本机是 `http://127.0.0.1/zentao`）以及**禅道账号与密码**，然后用 `/zentao board 2` 或问「禅道的任务列表」做一次真实读。

装好后若哪一项与上表不符，把 `/zentao doctor` 的输出发我即可。

---

## 安装

在 Harness Web 侧栏打开 **Plugins** 页安装本目录；或让 Agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填本包目录的绝对路径。

安装后用 `/zentao doctor` 看诊断，或问 Agent「禅道的产品列表有哪些」。

> 不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要自己跑 pnpm —— 交给插件管理器。

## 配置

在 **Plugins** 页找到 **禅道 ZenTao** 卡片，填入：

| 字段 | 说明 |
|---|---|
| 站点地址 `baseURL` | 如 `https://zentao.example.com`（如果禅道装在子目录下，写成 `https://host/zentao`） |
| 站点名 `label` | 只影响显示 |
| 写入策略 `writePolicy` | `readonly` 拒绝一切写入 / `confirm` 每次写入都要确认（默认）/ `trusted` 仅删除类与批量需要确认 |
| 允许未校准写 `allowUnverifiedWrites` | **默认关闭**。未打开时，那些"官方手册没给出 REST 形状"的写动作（目前只剩 `comment`）只能 `dryRun`，真实执行会被阻止。核实过真实行为后再打开 |
| 附带原始载荷 `includeRawPayload` | 校准字段名时打开：查询结果里给首条、详情里给该条，附带**已脱敏**的原始 JSON（秘密字段会被替换成 `***`） |
| 接口方言 `dialect` | 保持 `auto`（自动探测）；企业版 6.0+ 会探到 `rest-v1` |
| **账号 / 密码** | 填你的禅道登录账号与密码。**两者都存进 DSH 凭据库**，不写进配置文件；插件用它们自动换取 API Token |

**认证怎么工作的**（实测约束：禅道 REST v1 **只认 `Token` 请求头**，不能每次请求都带账号密码）：

```
凭据库【账号 + 密码】 ──POST /api.php/v1/tokens──▶ API Token（**只在内存缓存，不落盘**）
                                                      │
                                    所有请求带 Token ◀─┘
收到的 401 ──▶ 丢掉缓存的 Token ──▶ 下一次调用自动用账号密码重换（你不需要手动重登）
```

所以：**密码是长期凭据，Token 是一次性产物**。Token 的有效期禅道不返回（实测查不到任何到期字段），插件按 30 分钟保守缓存 + 401 立即失效。

凭据名默认是 `ZENTAO_ACCOUNT` / `ZENTAO_PASSWORD`（可在卡片里改）；如果这两个环境变量在**启动 Harness 之前**已导出，设置页会显示"由进程环境变量提供（只读）"，此时以环境变量为准。

也可以用 `/zentao login` 交互式输入（密码框是 secret 类型）——**不要把密码写在命令里**，命令文本会进会话记录。

## 用法

### 工具（Agent 自动调用）

| 工具 | 作用 |
|---|---|
| `zentao_query` | 查列表（产品/项目/执行/需求/任务/Bug/用户/计划/发布/版本/用例/测试单），支持过滤、排序、分页、字段投影 |
| `zentao_get` | 查单条详情，并返回**版本号**（写入时传回可避免覆盖他人修改） |
| `zentao_my` | 汇总"我的"任务与 Bug（禅道 v1 没有聚合端点，这是插件扫描多范围后本地匹配的，会如实标注扫描范围） |
| `zentao_write` | 受控写入（见下） |
| `zentao_board` | 一次拿到某个执行/项目/产品的看板：分组计数 + 阻塞项 + 高优先级项 |

**注意禅道 v1 的端点形态**（不是插件的限制）：任务必须指定 `scope.execution`，Bug 必须指定 `scope.product`，需求要给 `scope.product`/`project`/`execution` 之一。

### 持久化与幂等窗口

- 探测结论与**幂等记录**会存进 DSH 的 storage domain，**跨重启保留**。幂等记录跨重启很重要：它保证"窗口内重放同一次写"不会被重复落库。
- 如果 Host 没有提供持久化（或打开失败），插件会降级为纯内存并**照常工作**，但幂等窗口不跨重启。**`/zentao doctor` 会明确告诉你当前处于哪种状态、以及降级原因** —— 不需要去翻日志。

### 命令

```
/zentao                查看站点、方言、凭据、写入策略与缓存状态
/zentao doctor         重新探测并输出完整诊断事实表
/zentao sweep          **只读**端点扫描：逐个实体发一次 GET，报告可用性、响应字段名与状态样本
/zentao sweep task bug 只扫指定实体
/zentao login          交互式输入禅道账号与密码（密码不进命令文本），随后换取 Token 验证
/zentao switch                  不带参数：**列出所有产品及其编号**（不知道 id 时先跑这个）
/zentao switch <编号或名称> [执行编号]   设置本会话默认范围（之后工具可省略 scope）
/zentao board <执行id> 列出该执行的计数与阻塞项
/zentao actions        列出可用写操作及其支持的实体
/zentao help           帮助
```

### 校准流程（拿到真实禅道后的第一步）

`/zentao sweep` 是**只读**的（只发 GET），可以放心对着生产库跑：

1. 跑 `/zentao sweep`，把报告里的三段回贴给插件维护者：
   - **观察到的字段名** —— 用来标定归一化（禅道字段名与文档可能不一致）
   - **状态/优先级样本** —— 用来标定状态映射表（文档写 `Completed`、线上可能是 `done`）
   - **响应信封键名** —— 确认列表包装与分页字段
2. 报告同时会列出**哪些实体可用/空/404/无权限/返回了网页**，这直接决定工具面能用哪些实体。
3. 需要看某个实体的完整原始 JSON 时，打开设置页的 `includeRawPayload`，再查一次 —— 结果里会附带**已脱敏**的原始载荷（秘密字段替换为 `***`）。
4. 未校准的写动作：先用 `dryRun=true` 看真实请求行，在**测试环境**确认行为，再打开 `allowUnverifiedWrites`。

### 写入

```
zentao_write(action="update", entity="task", id="18", payload={patch:{pri:1}}, dryRun=true)
→ 回显将要发出的请求（不落库）
zentao_write(action="update", entity="task", id="18", payload={patch:{pri:1}}, dryRun=false)
→ 经用户确认后写入，然后**强制回读**并报告差异
```

写入结果里的三种标记要分清：

- `✓ #18` —— 写入被接受，**且回读确认**了改动确实生效
- `? #18` —— 写入请求被禅道接受了，但**回读校验失败**（网络/形状问题）。这不等于写入失败，也不等于成功：结果**未确认**，请到禅网上复核
- `✗ #18 UNSUPPORTED` —— 写入没有被接受

第 ②、③ 步之间还有一道保护：写入前会先读当前对象；**如果读不到可识别的对象，就中止写入**（绝不会在"不知道当前状态"的情况下改数据）。

可用动作：`create` `update` `start` `finish` `assign` `comment` `resolve` `close` `delete` `log_effort`。

**两处最容易搞错、插件会主动拦下的地方**：

1. **改任务/Bug 的状态不能用 `update`**。禅道的 `PUT /tasks/:id` 与 `PUT /bugs/:id` 字段表里没有 `status`：任务用 `start`/`finish`，Bug 用 `resolve`/`close`。传了会被拒绝并告诉你正确做法。
2. **新建任务的字段名是 `name`**（不是 `title`），且 `assignedTo` 是**数组**；新建任务必须给 `execution`，新建 Bug 必须给 `product`。

写操作的字段白名单来自官方手册逐页核实的字段表，**白名单外的字段一律拒绝**（不是静默丢弃）。

## 安全模型

- **凭据**：只有 Token 进凭据库；配置文件里只有引用名。工具结果、错误消息、日志、诊断输出里的 token/cookie/密码都会被脱敏。
- **确认门禁**：写操作走 DSH 的 `tools/pre-execute` → `ask`，由宿主弹确认。**approval 通道不可用时自动拒绝**（fail-closed）。
- **破坏性操作不放宽**：`delete` 与批量写在任何策略下都要确认。
- **并发写**：允许子代理写，因此有三重保护 —— 同对象写串行化（`entity:id` 粒度）、乐观并发校验（把上次读到的
  `updatedAt` 作为 `expectedVersion` 传入；冲突返回 `CONFLICT`、**不发写请求**、**不自动覆盖重试**）、幂等键 + 强制回读。
  **精度边界**：禅道的 `lastEditedDate` 是**秒级**精度（且本机 PUT **不递增 `version`**），所以**同一秒内**的两次编辑
  在服务端看不出差别、无法拦成冲突 —— 此时退回"写入后回读比对并如实报告差异"；从未编辑过的记录没有时间戳基线，同理。
- **不可信数据**：禅道正文/评论是外部输入，插件剥掉 HTML、截断并标注为不可信数据；技能文档也明确要求模型不要把其中的指令当指令。
- **出网**：使用 Node 全局 `fetch`，因此自动遵循 `http_proxy`/`https_proxy`/`no_proxy`/`all_proxy`；插件**不**自建 HTTP Agent（那会绕过代理）。

## 校准状态（重要）

| 项目 | 状态 |
|---|---|
| 取 Token（`POST /tokens`，账号密码换取）、`Token` 认证头、列表信封 `{page,total,limit,<集合键>}`、详情为裸对象 | **已核实**（官方二次开发手册） |
| 列表路径（含任务/Bug 的父资源路径）、`page`+`limit` 分页参数 | **已核实** |
| 写操作：task start / finish | **已在本机真实禅道实测确认**：`start` body `{left, consumed, realStarted, comment}` → 之后 `doing`、`left/consumed` 按传入值；`finish` body `{currentConsumed, finishedDate, comment}` → 之后 `done`、`consumed` 累加（`finishedDate` 要带时间，否则会报"实际完成不能小于实际开始"） |
| 写操作：create / delete / close / assign / 工时（任务、Bug、需求） | **已在本机真实禅道（IPD 5.6）逐条实测确认**：关闭见下；指派任务走 `POST /tasks/:id/assignto`（**必须给 `left`**），Bug 走 `POST /bugs/:id/assign`；删 Bug/需求都是**软删除**；`resolve` 必填 `resolution` + `resolvedBuild` |
| 写操作：任务/需求的 close | **已实测确认**：任务 `start→finish→close` 后 `status=closed`；需求在 `reviewing` 状态也能关闭（**必须给 `closedReason`**）。`reason` 会被映射成禅道认识的 `comment` 真正写进去 |
| **写操作：`log_effort`（工时）** | **已实测确认（端点找错过两次才对）**：`POST /tasks/:id/estimate`、`/bugs/:id/estimate`、`/stories/:id/estimate`。任务/需求字段 `{date, consumed, left, work}`，Bug 是 `{dates, consumed, work}`（无 `left`）。~~早期"该版本没有工时端点"的结论是错的——那只是我猜的路径不对~~ |
| 写操作：`comment` | **实测反证 + 结构性确认**：`PUT` 详情带 `comment` 返回 200 却不产生任何动作记录；而权威路由表（`config/apiv1.php`，131 个端点）里**根本没有任何 comment 路由** → 该动作在本版本不存在，插件如实报"未校准"并由闸门拦住 |
| 写操作：任务的 delete | **未核实**（手册没有 REST 形状）→ dryRun 会显示真实请求行并警告，`/zentao doctor` 会列出，且**默认被 `allowUnverifiedWrites` 阻止真实执行** |
| 数组形态字段 | **已实测**：任务的 `assignedTo` 与需求的 `reviewer` 必须传**数组**（`["admin"]` / `[2]`）——传字符串或数字会被禅道判成"不能为空"；需求的 `spec`（描述）也是必填 |
| `version` / `updatedAt`（乐观并发） | **实测**：本机 PUT **不递增 `version`**（连着两次更新后一直是 `"1"`），所以版本校验在真机上不可能触发；`lastEditedDate`（= 归一化后的 `updatedAt`）**每次更新都变**，因此**并发基线请传 `updatedAt`** —— 陈旧基线会被拦成 `CONFLICT` 且不发写请求（真机验证）。**限制**：时间戳是**秒级**精度，同一秒内的多次编辑无法区分；从未编辑过的记录没有该字段 |
| 请求侧分页参数 | **已实测**：v1 只认 `page` 与 `limit`（`recPerPage`/`perPage`/`pageSize` 全被忽略）；`recPerPage` 是 **v2** 的参数名 |
| 请求侧**条件过滤**参数 | ✅ **已实测为"不存在"**：`q`/`title`/`assignedTo`/`keywords`/`browseType`/`pri`/`severity` 传不可能匹配的值仍返回全部；而 **`status` 会把结果清空**（传真实状态也返回 0 条），插件因此从不发送它。**过滤一律在本地做** —— 这就是"扫描有页数上限、触上限会标注不完整"的原因 |
| 端点路径（列表/详情/动作） | ✅ **已逐条实测 + 权威路由表核对**（`config/apiv1.php` 是禅道自己的显式路由表，196 行）：详情路径的资源名是**复数**（`/bugs/1` ✓，`/bug/1` ✗）；**产品计划的详情是 `/productplans/:id`**（列表段却是 `/products/:id/plans`，不对称）；**不带范围的 `GET /testtasks` 返回 200 空 body**，但 `/projects/:id/testtasks` 正常 → 插件要求项目范围 |
| 错误体形状 | **已实测三种**：`{"error":"消息"}`、`{"error":{"字段":["消息"]}}`、以及 v2 的 `{"status":"fail","message":{…}}`（**HTTP 200**） |
| 删除语义 | **已实测为软删除**：`deleted: true`，详情仍可读、列表不再返回。删除的回读校验据此判断"对象是否真的不可用" |
| 网页深链格式 | ✅ **已确证**（禅道自身路由代码 + **本机运行级 15/15**）：`<baseURL>/<entity>-view-<id>.html`。实测中修正了一处：产品计划的模块名是 **`productplan`**（禅道没有 `plan` 模块），所以计划链接是 `productplan-view-<id>.html`。`includeWebLinks` 仍可关闭 |
| Token 有效期 | **没有可读的到期时间**（无 token 表、`GET /tokens` 返回空体、两次取到的值不同）→ 只把 **401** 当失效信号并提示重新登录，不做"永不过期"假设 |
| 用户实体 | `/user` 把当前用户包在 **`profile`** 键里；`/users` 列表项只有 `{account, realname}`（**无 id**） |
| 项目/执行的**创建** | 不在插件范围内（插件管理工作项，不建项目结构）；实测 **v1 的 `POST /projects` 不接受 `workflowGroup`，只有 v2 能建项目/执行** |

**首次在真实禅道上使用写入前，请在测试环境按 `/zentao doctor` 列出的"未核实"项逐条验证。**

> 上表中"已实测"的部分，取证过程与命令记录在 `design/02-detailed-design.md` 附录 C.17–C.21；§7.6 六项的逐条终判与 §14.2 的验收现状见 **附录 C.21**。

## 排障

先跑 `/zentao doctor`，它会输出：站点、baseURL、方言与探测过程（每一步的 HTTP 状态码与 Content-Type）、当前账号、缓存模式、以及写操作形状的校准状态。

| 现象 | 排查 |
|---|---|
| `AUTH_REQUIRED` | 还没有 Token：`/zentao login` 或在设置页填 |
| `AUTH_EXPIRED` | Token 失效：重新获取 |
| `UNSUPPORTED` 且说"返回的是网页（HTML）" | **最常见的问题**：baseURL 少了禅道子目录（应写 `https://host/zentao`），或该站点 REST API 未启用、未认证时被登录页以 200 接管 |
| `UNSUPPORTED` 且说"响应不是 JSON" | 该地址不是禅道的 REST 端点，或响应被代理/网关改写 |
| `UNSUPPORTED` 且列出 `envelopeKeys` | 列表响应信封与预期不同：把这行（含实际键名）连同 `/zentao sweep` 输出反馈即可校准 |
| `UNSUPPORTED` + 探测事实 | 检查 baseURL 是否少了 `/zentao` 子目录、禅道后台是否开启了 API |
| 部分实体报无权限（403） | **不会**因此判定方言不支持：探测会依次试产品列表、项目列表、当前用户，**任何一个通就认**。`/zentao doctor` 会列出"被拒端点"，说明你的账号缺哪个模块的权限 |
| `NETWORK` 且 hint 提到证书 | 内网自签名：**在启动 Harness 之前**设置 `NODE_EXTRA_CA_CERTS` 指向企业根证书。插件不会关闭证书校验 |
| 代理环境 | 插件用全局 `fetch`，导出 `HTTPS_PROXY` / `NO_PROXY` 即可；loopback 永远直连 |
| 写入报 `UNSUPPORTED`（HTTP 405） | 该写操作的路径/方法尚未实测校准 —— 看 `/zentao doctor` |
| 写入报"请求形状尚未经真机校准" | 该动作的 REST 形状手册没给：先用 `dryRun=true` 看请求行，核实后再打开 `allowUnverifiedWrites` |

## 开发

```bash
npm test    # 342 项离线测试，不需要禅道
```

### 两套测试

1. **`npm test`（342 项，自包含）** —— 用 `test/stubs/dsh.mjs` 替换 `@deepseek-ai/*` 与 `zod`，
   因此**不需要安装 DSH 也能跑**。其中 `test/assembly.test.js` 会真的 import `index.js` 并驱动
   `apply()`，顺带把工具定义当 schema linter 校验；`test/client.test.js` 用**有状态**的 React 桩
   真的渲染三个客户端组件并**驱动交互路径**（保存被接受/被拒绝/抛错/内存模式、看板的会话发现与收起展开），
   并断言**没有任何硬编码颜色**（所有颜色都是 `var(--token, fallback)`，暗色主题自动生效）；
   **`test/routes.test.js` 是路由守卫**：把本插件可能发出的每一条路径（读 + 写）逐条对照
   `test/fixtures/apiv1-routes.js` 里抄自禅道 `config/apiv1.php` 的 **150 条真实路由**，
   任一路径写错就立刻变红（我用它挡住的正是自己曾经写错的 `/plans/:id`、`/tasks/:id/efforts` 等）；
   `test/manifest.test.js` 做可安装性验收（exports 指向、`files` 覆盖全部源码、示例 config 与 schema 一致、icon 约束等）。

2. **真实包契约校验（15 项，默认跳过）** —— 上面那套用的是**按文档推测**的桩。
   这一套把真实包解析进来，用真实的 `schemastery` / `defineTool` / `defineDomain` /
   `credentialRef` / `zod` / `validateJsonSchemaValue`，以及**真实的补丁与 profile 装载器**
   （`dsh-app-boot` 的 `loadOverlayPatches` + `composeEntries` + `loadProfileDirectory`）
   去撞本插件的**真实定义、补丁与打包**，回答"拿到真机会不会加载失败、模型看到的工具长什么样、
   **装上能不能解析并组合成功**"：

   ```bash
   # 先用 asar 抽取器把这些包的 lib/** 与 package.json 抽到一个目录（含 zod）：
   #   @deepseek-ai/{cordis,cosmokit,dsh-brand,dsh-tools,dsh-credentials,dsh-storage,
   #                  dsh-storage-domain,schemastery,dsh-app-boot,dsh-atomic-write,
   #                  dsh-home-paths,dsh-launch-environment,cordis-plugin-loader,
   #                  cordis-plugin-group}（这几个建议整包抽取：内部有相对导入）
   #   以及 zod / yaml / js-yaml / semver / resolve.exports
   DSH_REAL_MODULES=<抽取目录> node --import ./test/register-real.mjs --test test/real-contract.test.mjs
   ```

   它校验：`Config` 能被真实 schemastery 解析且 volatile 字段是活引用、除 `baseURL` 外每个字段都有
   默认值、真实 `defineTool` 接受 5 个工具定义、参数 DSL 投影成合法 JSON Schema 且 `required` 一致、
   参数校验**真的**会拒绝非法参数、真实 `defineDomain`+`zod` 接受域声明、`credentialRef` 接受引用名、
   以及 **补丁能被真实装载器解析并应用（零警告）**。其中三条是**防空转**断言：「故意写错的定义必须被拒绝」
   「枚举外的值必须被拒绝」「写成单个映射的 `insert` 必须让真实 loader 失败」。

测试用桩模块替换 `@deepseek-ai/*` 与 `zod`，因此**不需要安装 DSH 也能跑**（见 `test/stub-*.mjs` 与 `test/register-stub.mjs`）。

源码分层（依赖严格向下）：

```
index.js                 Host 半入口（必需依赖只有 tools，其余服务惰性接入）
client.js                Client 半（设置卡片 + 会话绑定的禅道卡片）
src/tools.js             L4 工具定义（中文描述、ASCII 标识符）
src/guard.js             写入门禁（tools/pre-execute → ask/deny）
src/commands.js          /zentao 命令族
src/skill.js, prompt.js  内嵌技能与提示词段
src/projection.js        会话投影 + 进程内会话上下文
src/service.js           L3 用例：读、写、并发保护、扫描边界
src/domain/*             L2 纯逻辑：模型/归一化/查询/锁/策略/错误/渲染（可离线单测）
src/transport/*          L1 传输：fetch 包装、探测梯、方言（REST v1 已实现）
src/store.js             持久状态（探测结论持久，其余为进程内缓存）
src/auth.js, config.js   凭据解析与配置
```
