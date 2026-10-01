# DSH 禅道（ZenTao）插件 — 框架设计

> 文档 1 / 2：**框架设计**（本文）→ `02-detailed-design.md`（详细方案）
> 目标产品：DeepSeek Harness Desktop `0.2.0-rc.2`（Cordis `4.0.4`，schemastery `3.18.4`）
> **目标禅道：企业版（REST v1，6.0+），单站点，需要写操作。**
> 状态：设计稿，未实现。文中每一条 DSH 扩展点均已对**本机已安装产物**核验（`app.asar` 内的 `lib/*.js` 与包 `README.md`），核验出处逐条标注。**D1–D7 七项决策已拍板，见 §9。**

---

## 0. 一句话结论

禅道插件应当是一个**常驻安装的 Cordis Bundle（同包双半：Host 半 + 可选 Client 半）**，以 `ctx.zentao` 领域服务为核心，向上暴露**少量粗粒度工具 + 斜杠命令 + 内嵌技能 + 设置页/侧栏面板**，向下通过**可插拔方言适配器**同时兼容禅道 REST v1 与传统 `api.php`，凭据一律走 DSH 凭据缝、绝不落进配置，写操作一律经 `tools/pre-execute` 的 `ask` 门禁。

**不走 MCP 封装**是本设计最重要的取舍，理由见 §3.2。

---

## 1. 目标与非目标

### 1.1 目标

| 编号 | 目标 | 可观测的成功判据 |
|---|---|---|
| G1 | 让 Agent 能**只读**回答禅道里的真实状态（我的待办、需求、任务、Bug、迭代进度） | 一次提问即产出正确条目，且每条带可点击的禅道网页链接 |
| G2 | 让 Agent 能**受控写入**禅道（建需求/建任务/提 Bug/指派/备注/登记工时/关闭） | 写入前有用户确认；写入后回读到一致状态 |
| G3 | 凭据**永不进入配置文件、日志、工具结果** | 配置文件中只出现引用名（如 `ZENTAO_TOKEN`）；工具结果中无 token/cookie |
| G4 | **企业版**（REST v1）+ 单站点，工具面与版本无关，运行时自动探测 | 探测梯区分 401/404；能力协商而非版本分支 |
| G5 | 在 DSH 里"像一个原生功能"：设置页可配、命令可切换上下文、会话可追溯 | 设置页能测连通性；`/zentao` 能切换当前产品并落日志 |

### 1.2 非目标（明确不做）

- ❌ 不做禅道**全字段镜像同步**（不做"把禅道搬进 DSH 数据库"）；只做按需查询 + 有界缓存。
- ❌ 不做禅道的**权限提升**或绕过（插件以某个禅道账号的身份行事，该账号的权限就是上限）。
- ❌ 不新增 Session 事件类型（DSH 硬约束：新 `type` 的事件会让会话无法重新打开，见 §5.3）。
- ❌ 不在 v1 做"双向实时同步"或 Webhook 反向写入。
- ❌ 不引入自己的 HTTP 传输栈（见 §8.3）。

---

## 2. 已核验的 DSH 扩展点（设计的事实基础）

以下全部为核验结论，不是推测。`README.md` 指 `app.asar` 内该包的文档（本机已提取核验）。

| 能力 | 确切 API | 核验出处 |
|---|---|---|
| 注册工具 | `ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, execute }))`；参数 DSL 支持 `string/number/integer/boolean/null/array/object/json/oneOf` | `dsh-tools/README.md §Register a tool` |
| 工具流水线 | `tools/pre-execute`（可扩展 allow/deny/**ask** 瀑布）→ guards → `tools/execute` → `tools/post-execute` → `tools/result` | `dsh-tools/README.md §Enforce policy`；`dsh-tools/lib/types/index.js:876` |
| `ask` 决策落地 | `ask` 由 approval 缝解析为 `allowed-once` / `rejected`；**approval 服务缺失时 fail-closed 为拒绝** | `dsh-tools/lib/types/index.js:1093-1116` |
| 单调拒绝 | `ctx.tools.guard(fn)`：返回 reason 即拒绝，后续监听器无法翻案 | `dsh-tools/README.md §Enforce policy` |
| 按 Agent 收窄 | `ctx.tools.restrict(filter)`（只能做减法，需 scoped context，全局调用会抛错） | `dsh-tools/README.md §Restrict`；`lib/types/index.js:513` |
| 配置 + 秘密 | `const Config = z.object({...}); export { Config }`；字段角色 `z.string().role("secret")` / `.role("credential-ref")`；`.volatile()` 后的字段是**活引用**，运行时以 `config.x.get()` 读取 | `dsh-web-search-deepseek/lib/index.js:277,329-338` |
| 配置表单 | 设置页按**探针条目 id** 定位命名空间；`autoGenerate` 默认开启；自带页面的插件在 `apply` 内 `ctx.inject(['settings'], …)` 子上下文里 `configure({ auto: false }, ctx.fiber)` | `dsh-settings/README.md §Use this package` |
| 凭据（键值） | `credentialRef(name)`；`ctx.credentials.resolve(ref) → {value,source}`、`describe(ref) → {configured,source?,writable}`（**永不返回值**）、`set`、`unset` | `dsh-credentials/README.md §Storing keys` |
| 凭据（记录） | `credentialKey(scope,id)`；`readRecord` / `describeRecord` / `listRecords` / `modifyRecord(key, mutate)` / `deleteRecord` | `dsh-credentials/README.md §Records` |
| 凭据落地 | 本地提供者写入 `$DSH_HOME/.credentials.yaml`；进程环境变量优先且**只读**（无法覆盖） | `dsh-credentials-local/README.md`；`dsh-client-connection/README.md` |
| 人类授权流程 | `ctx.authorization.registerFlow({ key, label, methods, async run(session){…} })`；`session.notify/prompt/signal`；`begin()` 结果 `authorized`/`cancelled`；流程**必须在 resolve 前提交凭据**，否则 `NOT_COMMITTED` | `dsh-authorization/README.md §Registering a flow` |
| 持久 KV | `defineDomain({ name, version, tables })` + `ctx.storageDomain.open(spec)` → `table.put/get/update`，读同步、写先持久后变更并 emit `domain/changed` | `dsh-storage-domain/README.md §Opening` |
| 后台作业 | `ctx.jobs`；作业归发起会话所有；**需 `dsh-tool-jobs` 挂载 controller 才能启动**；`job.list`/`job.follow`/`job_kill` | `dsh-jobs/README.md §Starting background work` |
| 斜杠命令 | `ctx.commands.register({ name, description, input:{hint}, handler({agent,rawInput}) })`；handler 直接跑、不产生模型消息；返回 `{kind:'success'|'error', text}` | `dsh-commands/README.md §Registering a command` |
| 内嵌技能 | `ctx.skills.register(...)`：插件注册**内存技能**，注册表补默认调用策略并打 `runtime` provider 标签；调用策略 `modelInvocable`/`userInvocable` | `dsh-skill/README.md §What the registry gives you` |
| 会话投影 | `ctx.sessionProjections.register({ key, stateSchema, stateVersion, init, apply, wire:{viewSchema,view} })`；`apply` 纯同步、忽略的事件必须返回同一引用；`wire.view` 供客户端 | `dsh-session-projection/README.md §Define a projection unit` |
| 提示词贡献 | `ctx.systemPrompt.section({...})`；变量 `ctx.systemPrompt.variable(name, fn)` | `dsh-system-prompt/README.md` |
| 出网 | 直接用 Node 全局 `fetch()`；`dsh-http-proxy` 由 launcher 在首个插件加载前装好全局 dispatcher，读取 `http_proxy/https_proxy/no_proxy/all_proxy`（`$DSH_HOME/.env` 亦可）；**自建 `new Agent(...)` 当 dispatcher 会静默绕过代理**（有 `verify-no-bare-dispatcher` 门禁） | `dsh-http-proxy/README.md §Writing a new outbound call` |
| 包依赖 | 随 dsh 安装的包**从安装位置解析**，workspace bundle **无需声明依赖** | `cordis-plugin-development/SKILL.md:18` |
| 插件导出形态 | `export function apply(ctx, config)` + 可选 `export const inject` / `export const Config`；或默认导出 service class（二者不可混用） | `cordis-plugin-development/references/host-plugin.md §Host plugin export forms` |
| 客户端半 | `dsh.client = { platform:'web', immediately?, inject[], external? }` + `exports["./client"]`；浏览器侧 `window.__ModuleLoader__.load({ id, factory(require){…} })`，factory id 必须等于包名；React 来自浏览器模块表 | `references/ui-plugin.md`；`templates/decoration/{package.json,client.js}` |
| 设置页挂载点（A：官方卡片式） | 客户端 `ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({ id, label, locale }, Component)))`；命名空间用 `ctx.configForms.get(NS)` 取，凭据读写走 `ctx.remote.credentials.describe/set`，失效订阅 `ctx.remote.$on('credentials/reference-updated', …)` | `dsh-client-ui-settings-web-search/lib/client.js:300-313`；同包 `README.md §Implementation` |
| 设置页挂载点（B：插件页标签页） | `settings.plugins.tab` 槽，注册需带 `id` + `order` + 本地化 `label`；section 按 order 渲染，**首次选中才挂载**；唯一贡献者时直接当整页 | `dsh-client-ui-settings-plugins/README.md:30` |
| 其它设置座位 | `settings.section`（导航页）、`settings.general.item`（General 段内一行）、`settings.onboarding`、`settings.launcher`、`sidebar.settings` | `dsh-client-ui-settings/README.md:42,53`；`dsh-client-ui-settings-general/README.md:46,54,70` |
| 配置表单模型 | `ctx.configForms.get(entryId)` → 快照含 resolved `value`、继承 `base`、raw `user`、`revision`、可写性、持久化模式；`set`/`unset`/`mutate(ops, expectedRevision)`；冲突保留草稿；`ctx.settingsSchema` 负责 rehydrate 与校验 | `dsh-client-ui-settings/README.md:34,42,70` |
| 客户端文案（i18n） | `ctx.locale.register(ns, { zh, en })`（**两种内置语言必须齐全**）+ `ctx.locale.bind(ns)`；查找顺序：本 ns 活动语言回退链 → `common` 链 → key 本身。**Host 半不注册字典** | `dsh-client-locale/README.md:38,66,94,101` |
| 右侧栏面板（P2） | 两段式：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })` + `ctx.slots.register({ name:'sidebar.right.pane.tab', key: definition.id }, Body)`；两者**都须在类型自己的 `ctx.effect` 内** | `dsh-client-ui-sidebar-right/README.md:81-84` |
| 侧栏面板状态 | 每个 session 一份 `SurfaceState` 存于注册时声明的 store，localStorage 键 `dsh.sidebar-right.v1.<sessionId>`；导航参数/资源内容**不算** layout 状态 | `dsh-client-ui-sidebar-right/README.md:66,74` |
| 槽位注册通则 | `ctx.slots.inject(id, () => ctx.slots.register({ name, key?, id?, order?, locale?, select?, inject? }, Component))`；注册到未声明槽位、重复声明子槽、chain 缺 `select` 均**加载时 throw** | `dsh-client-ui-slots/README.md:46`；`dsh-client-ui-workspace/README.md:153-159` |
| 客户端→主机调用 | 只依赖 `@deepseek-ai/dsh-api-remotes` facade：`ctx.remote.<ns>.<method>()`、`ctx.remote.$mount()`、`ctx.remote.$on`（白名单转发事件）、`ctx.remote.$host` | `dsh-api-remotes/README.md:14,34,43` |
| 浏览器半注册签名 | 官方模板用 `window.__ModuleLoader__.load({ id, factory(require){…} })`，`id` 必须等于包名 | `cordis-plugin-development/templates/decoration/client.js`（**注**：该签名只存在于官方模板，`dsh-client-modules/README.md` 未文档化 —— 以模板为准） |
| 安装与装载 | `plugin_manager` 的 `install_bundle`（或 Web 侧栏 Plugins 页）完成 pnpm 安装 + bundle 选中；**不要手写 profile 的 `package.json`/`cordis.patch.yml`** | `cordis-plugin-development/SKILL.md:8-10`；`dsh-plugin-manager/README.md` |
| 全局工具可见性 | "restrict 是对**全局工具**的掩码；scoped 注册保持可见" → 根上下文注册的工具被每个 Agent 继承 | `dsh-tools/README.md §Restrict tools per agent` |
| 组合层级 | `dsh-base` insert → `dsh-web-app` overlay → profile `cordis.patch.yml` → `--patch`；每层按 `id` 覆盖且 **config 整体替换不深合并** | `dsh-base/cordis.patch.yml:1-13`；`cordis-composition-reference/SKILL.md §Loader patch dialect` |

### 2.1 由核验事实直接推出的设计约束

1. **写操作门禁用 `tools/pre-execute` 返回 `ask`**，不要自己发明确认机制 —— 它与会话的权限预设（`read-only` / `workspace-write` / `danger-full-access`）天然一致，且 approval 缺失时自动拒绝。
2. **凭据用"引用角色"**：配置里放 `credential-ref`（名字），值放凭据缝；`describe` 只回报存在性与可写性 —— 这正好满足 G3。
3. **不能用 `new Agent({dispatcher})`**：会破坏企业代理。裸 `fetch` 即可。
4. **不能新增 Session 事件类型**：会话当前上下文要靠**既有事件的投影**派生（本设计用命令运行事件，见 §5.3）。
5. **`.volatile()` 字段是引用**：所有读取必须 `config.x.get()`，且在**每次操作入口**取值（这样用户在设置页改完立即生效，无需重启）。

---

## 3. 框架总体设计

### 3.1 分层

```
┌─ L5 交付层  bundle manifest · cordis.patch.yml · locale/ · icon.svg · 装载与升级
│
├─ L4 交互面  Tools(zentao_*) │ Commands(/zentao) │ Skill(zentao-workflow) │ Client UI(设置页/侧栏面板)
│                     ↑ 都只调 L3，不各写一套逻辑（DSH 官方要求，见 user-actions.md）
│
├─ L3 领域服务  ctx.zentao  ── 用例编排 · 写入策略 · 结果裁剪 · 上下文(当前站点/产品)解析
│        │                    └─ 同时是 Host service：UI 与工具共用同一入口
│        │
├─ L2 核心域   归一化模型 · 查询构建 · 分页游标 · 错误分类 · 字段/状态映射 · 链接生成
│        │
└─ L1 接入层   ZenTaoClient(传输) ── 方言适配器 Dialect: rest-v1 │ legacy-api │ …probe
                  │
                  └─ fetch()（自动走 dsh-http-proxy）· 重试/超时/断流 · 单站点串行队列
```

依赖方向**严格向下**：L4 不碰 HTTP，L2/L3 不认识"REST 还是 api.php"（方言只在 L1 内可见）。

### 3.2 形态决策：为什么是 Bundle 而不是 MCP

| 维度 | MCP 封装（`dsh-mcp-client` + 自写 MCP server） | **Cordis Bundle（本设计）** |
|---|---|---|
| 贡献工具 | ✅ | ✅ |
| 凭据存储 | ❌ 只能把 token 写在 MCP `config` 里（明文 YAML）→ 违反 G3 | ✅ `credentials` 引用 + 记录 |
| 账号密码换 token | ❌ 无人类授权缝 | ✅ `ctx.authorization` 流程 |
| 设置页/侧边栏 UI | ❌ | ✅ Client 半 + `plugins.item` |
| 斜杠命令 / 内嵌技能 | ❌ | ✅ |
| 持久缓存/游标 | ❌ | ✅ storage domain |
| 写操作确认 | ❌ 需自己实现 | ✅ 复用 `tools/pre-execute` → `ask` |
| 后台批量同步 | ❌ | ✅ `ctx.jobs` |
| 跨版本适配 | 需进程内跑一个适配层，等于多一层 RPC | 进程内直连，一层适配器即可 |

结论：**MCP 只能覆盖禅道需求的约 1/3，且必然导致凭据进配置。** 不用动态 Cordis 包（`cordis_define` 那套）则是因为它面向运行时临时注册，缺少"可版本化、可升级、可回滚"的常驻安装语义。

### 3.3 组件与职责

| 组件 | 层 | 职责 | 明确不负责 |
|---|---|---|---|
| `ZenTaoClient` | L1 | 组装请求、加认证、超时/取消、重试、限流、响应解包 | 不理解业务语义 |
| `Dialect`（`restV1` / `legacyApi`） | L1 | 路径形态、认证头/Cookie、分页参数、错误体解析、能力声明 | 不认识 DSH |
| `CapabilityProbe` | L1 | 首次接触时探测版本/方言并缓存；失败降级 | 不改配置（只写 domain 缓存） |
| `Normalizer` | L2 | id/日期/状态/用户/链接归一化 | 不做 IO |
| `QueryBuilder` | L2 | 过滤条件 → 方言查询参数；字段投影 | 不做鉴权 |
| `Cursor` | L2 | 增量游标（`lastSyncedAt`/页游标）序列化 | 不做持久化（交给 domain） |
| `ZenTaoError` | L2 | 统一错误分类 + 给模型的下一步提示 | 不吞错 |
| `ctx.zentao`（`ZenTaoService`） | L3 | 用例方法、写策略、结果裁剪、当前上下文解析 | 不渲染 UI |
| 工具/命令/技能 | L4 | 参数校验与呈现 | 不含业务逻辑 |
| Client 半 | L4 | 设置页、侧栏面板、locale | 不直连禅道（一律经 Remote/Host） |

### 3.4 一次写入的时序（确认门禁）

```
模型 → zentao_write(action=update, id=123, patch={status:'resolved'})
  └─ tools/pre-execute 瀑布（本插件监听器）
       ├─ 读 Config.writePolicy.get()
       ├─ 判定：变更类 → 返回 { kind:'ask', ... }        [dsh-tools/lib:876]
       └─ 附 ToolErrorInfo（结构化 name/code）供 UI 展示
  └─ approval 缝 → 用户界面确认
       ├─ rejected  → 决策 {kind:'deny', reason:'the user rejected tool "zentao_write"'}
       └─ allowed-once → {kind:'allow'}
  └─ zentao_write.execute(args, exec)
       ├─ 幂等键检查（domain：同键已完成则直接回读，不重复写）
       ├─ 取凭据（每次操作入口）→ HTTP 写入
       └─ 回读校验 → 归一化 → 有界渲染（含网页链接）
```

> 关键点：`ask` 是**同步返回决策**、由框架去问人；插件自己**不**调用 `ctx.userQuestions`（那是给模型问业务问题用的），也不自己弹窗 —— 保持与 DSH 权限预设一致。

---

## 4. 工具面框架（形态，不含字段细节）

**少量粗粒度工具**，而不是"每个禅道实体一个工具"。理由：(a) 工具 schema 是每请求固定开销，且注册/注销会破坏 KV 缓存前缀（`dsh-tools/README.md §KV Cache effect`）；(b) DSH 官方实践建议"相关操作共用一个工具，用 `action` 参数区分"（`references/user-actions.md`）；(c) 粗粒度工具在 PTC 模式下同样友好。

| 工具 | 性质 | 覆盖 |
|---|---|---|
| `zentao_query` | 只读 | 列表检索：产品/项目/执行/需求/任务/Bug/用户/计划/发布/用例，支持过滤+分页+字段投影 |
| `zentao_get` | 只读 | 单条详情 + 关系展开（父子、关联需求/任务/Bug、历史、附件元信息） |
| `zentao_my` | 只读 | "我的"聚合：待办/任务/Bug/需求/今日工时 |
| `zentao_write` | **写** | `create` / `update` / `comment` / `assign` / `resolve` / `close` / `log_effort` |
| `zentao_board` | 只读 | 迭代/项目看板聚合视图（一次拉多实体，服务端/插件侧拼装，省往返） |
| `zentao_admin` | 写（高危） | 站点注册/切换、连接自检、缓存刷新（v1 可只由命令暴露） |

命名约定：全部以 `zentao_` 前缀，避免与现有工具撞名（`dsh-mcp-client` 也注册工具，前缀是廉价命名空间）。

---

## 5. 状态归属：四分法（本设计的骨架）

DSH 里"状态放哪里"决定稳定性与升级安全性。四分法如下，**互不混用**。

### 5.1 配置（`Config`，`.volatile()`）
放**非密、可公开**、用户可改、要参与 profile 持久化的东西：禅道站点（**单站点**，扁平字段：`baseURL`/`label`/`dialect`/`tokenRef`/`account`）、默认产品/项目、`writePolicy`、超时、页大小、字段投影默认值、`credential-ref` 名字。
**绝不放**：token、密码、Cookie。

### 5.2 凭据（`ctx.credentials`）
- **引用（ref）**：`ZENTAO_TOKEN`（单站点，一个名字就够）—— 适合 CI/运维统一注入，也适合用户自己粘贴 token。
- **记录（record）**：`credentialKey('dsh-plugin-zentao', 'token')`，`kind: 'grant'`，payload 含 `{ token, obtainedVia }` —— 适合"人在设置页粘一次，之后长期复用"。
- **存进去的永远是 token 本身**：认证方式已定为 API Token，因此**不存在**密码字段、不存在会话 Cookie 记录，也就没有"密码落盘"的风险面。设置页允许用账号密码**一次性**换取 token（`POST /tokens`），密码只活在这一次请求的内存里、用完即弃，**绝不写入任何凭据记录或配置**。
- **环境变量优先且只读**：若用户在启动 shell 里导出了同名变量，设置页只能显示"由环境提供、不可改"（`describe().writable === false`）—— UI 必须如实呈现，不能假装能改。

### 5.3 会话日志（唯一真相 + 投影）
**硬约束**：插件不得 append 新 `type` 的事件。因此"当前禅道上下文"（当前产品/执行；单站点故无站点维度）通过**既有的命令运行事件**派生：`/zentao switch <product>` 由 `ctx.commands.register` 的 handler 执行并返回结果；注册一个 `sessionProjections` 单元折叠命令运行记录 → `wire.view` 给客户端看板。
- `apply` 必须纯同步、忽略的事件返回同一引用（`dsh-session-projection/README.md:54`）。
- 投影状态用 **plain JSON**，并在字段/语义变更时 `stateVersion++`（利用投影检查点缓存）。

### 5.4 主机持久 KV（storage domain）
`defineDomain({ name:'zentao', version:1, tables:{ ... } })` + `ctx.storageDomain.open()`：
- `probe`：单条站点探测档案（`baseURL`、方言、`probedAt`、版本串）——**不含密文**；
- `entityCache`：id → `{title, statusCode, statusLabel, url, fetchedAt}`（短 TTL，避免重复拉详情）；
- `cursors`：`<entity>/<scope>` → 增量时间戳/页游标（单站点，故无站点前缀）；
- `idempotency`：写操作幂等键 → 结果摘要（防重放）；
- `writeLocks`：**不落盘**——同对象写串行化是进程内队列（见 §9.1），持久化它没有意义。

读同步、写先持久（`dsh-storage-domain/README.md:73-74`）；域句柄生命周期归 `ctx.effect` 的 disposer。若组合里没有 storage domain（headless 极简组合），**降级为进程内 Map 并明确告知能力受限**，而不是抛错。

---

## 6. 安全与权限模型

| 面 | 规则 |
|---|---|
| 凭据 | 只经 `ctx.credentials`；工具结果、日志、错误消息、`domain` 记录中永不出现 token/cookie/密码；错误分类里对响应体做**脱敏**（截断 + 抹掉 `Set-Cookie`、`token`、`password` 字段） |
| 写入 | `tools/pre-execute` 监听器按 `writePolicy` 决策：`readonly`（一律 deny，附可执行的理由与开启方法）/ `confirm`（默认；变更与删除都 `ask`）/ `trusted`（仅删除类 `ask`）。**删除类无论策略都 `ask`** |
| 批量写 | `zentao_write` 的批量形态强制 `dryRun` 默认 true，先返回"将变更清单"，模型需显式二次调用才落库 |
| 出网 | 只允许配置中的站点 origin；重定向不跟随跨 origin（凭据不跨站）；只走 `fetch` 全局 dispatcher，不自建 dispatcher |
| 输入 | 关键字/过滤值参数化进入查询串；对禅道返回的富文本字段默认**剥离 HTML**（或按需转纯文本），防提示注入经禅道数据回流 |
| 提示注入面 | 禅道里的需求/Bug 正文是**不可信内容**：渲染进模型结果时按 DSH 惯例包裹为数据（不当作指令）；技能文档里明确写出这条 |

> 最后一条尤其重要：客户会往 Bug 正文里写任何东西，其中可能包含针对 Agent 的指令。设计上把"禅道内容"整体视为 untrusted data。

---

## 7. 多版本适配框架（单站点）

### 7.1 方言（Dialect）接口

```
interface Dialect {
  id: 'rest-v1' | 'legacy-api'
  capabilities: { tokenAuth, pagination, fieldFilter, relationExpand, effortApi, attachment }
  authenticate(ctx, site, creds): Promise<AuthState>
  buildList(entity, query): RequestSpec
  buildDetail(entity, id, expand): RequestSpec
  buildWrite(action, payload): RequestSpec
  parseError(res): ZenTaoError
  parsePage(res): { items, next }
}
```

上层只见**归一化实体**，方言差异（`page/limit` vs `pageID`、Token 头 vs `zentaosid` Cookie、错误体字段名）全部封在 L1。

### 7.2 探测梯（首次连接时）

1. 读 `probe` domain 缓存 → 命中即用；
2. 未命中：按 `rest-v1` 发一个**无副作用读**（`GET /api.php/v1/products`，带 `Token` 头）；
3. 依据状态码与响应体分类：`200` 且响应体含 `products`/`total` → `rest-v1`；**`401` → 方言对、只是凭据缺失/失效**（抛 `AUTH_REQUIRED`/`AUTH_EXPIRED`，**不再往下探**）；`404`/非 JSON/结构不符 → 才考虑降级；
4. 全败 → 记 `UNSUPPORTED` 并把探测事实（每一步的状态码、Content-Type）写入错误提示，供用户判断；
5. 结果连同 `probedAt` 写入 `probe`，允许命令强制重探（`/zentao doctor`）。

> 具体探测端点与判别特征以 `02-detailed-design.md` 中的禅道 API 调研矩阵为准（该部分正在核验，避免在此猜测路径）。

### 7.3 单站点（已定）
配置里就是一个站点的扁平字段，**没有** `sites[]` 数组、**没有** `defaultSite`、工具参数里**没有** `site`。代价与收益要讲清楚：

- **收益**：配置面小一半；凭据只有一个名字（`ZENTAO_TOKEN`）与一个记录键（`zentao/token`）；缓存与游标不需要分区；工具 schema 少一个参数（省固定 token 成本）；少一整类"串号"风险。
- **代价**：要接第二个禅道需要改配置结构（`version` 升级 + 迁移）。接受这个代价，因为已确认是单站点场景，而"预留多站点"在 DSH 里并不是免费的——它会把 `site` 维度渗进每一层。
- **迁移路径**（若将来真要）：`Config` 加 `sites[]` 并对旧扁平字段做 `Schema.transform` 兼容，凭据记录键从 `zentao/token` 迁到 `zentao/<siteId>`；storage domain 的 `version` 递增并写一次性迁移。这条路径存在，所以现在的简化不是死路。

---

## 8. 交付形态与演进

### 8.1 包形态

```
@local/dsh-plugin-zentao          ← 一个包，双半
├─ package.json      dsh.bundle.patch + dsh.client + meta + icon + locale
├─ cordis.patch.yml  - insert: [ { id: zentao, name: '@local/dsh-plugin-zentao' } ]
├─ index.js          Host 半：apply(ctx, config) + Config + inject
├─ client.js         Client 半：window.__ModuleLoader__.load({ id, factory })
├─ locale/{zh,en}.json   显示文案（插件卡片/设置页）
└─ icon.svg
```

装载：用户在 Web 侧栏 **Plugins** 页安装，或 Agent 调 `plugin_manager install_bundle`（绝对路径）。profile 文件由管理器改写，插件**不**自己写。

### 8.2 演进路线

| 阶段 | 内容 | 价值 | 风险 |
|---|---|---|---|
| **P0 骨架** | L1 rest-v1 只读 + `zentao_query/get/my` + 设置页（连通性测试）+ 凭据引用 | 立刻可问"我的 Bug" | — |
| **P1 写入** | `zentao_write` + `pre-execute` ask 门禁 + 字段白名单 + 幂等键 + 读回校验 + **同对象写串行化** | 闭环干活（已确认要写） | 误写成本 → 靠确认门禁 + 白名单 + 读回 |
| **P2 上下文与 UI** | `/zentao` 命令 + 会话投影 + 设置页 + 看板（`main` 全屏 + 侧栏入口）+ 内嵌技能 | "像原生功能"（已确认要 UI） | UI 需跟随宿主主题令牌 |
| **P3 规模化** | 增量同步 job + 审计事件 + 企业版附加实体（反馈/工单） | 团队级使用 | 限流/性能 |

> 变更说明：**legacy 方言从 P1 降级为可选**（已确认是企业版，REST v1 自企业版 6.0+ 起提供，几乎必然可用）；**多站点从 P3 移除**（已定单站点）。

---

## 9. 决策基线（已拍板，实现按此执行）

| # | 决策 | 确定值 | 对设计的实际影响 |
|---|---|---|---|
| D1 | 目标禅道版本 | **企业版** | REST v1 自企业版 **6.0+** 起提供（已核验转述）→ `rest-v1` 为唯一必做方言；`legacy-api` 降为**可选**（省约 0.5 天）；探测梯仍保留 404 降级路径以备老部署 |
| D2 | 是否要写操作 | **要写** | `writePolicy` 默认 `confirm`；`zentao_write` 进入 M2 关键路径；dryRun 默认 + 字段白名单 + 读回校验全部为必需项，不是增强项 |
| D3 | 工具描述语言 | **中文** | 工具 `name` 保持 ASCII（`zentao_*`，机器标识符不入 i18n）；`description`、`enum` 的每项描述、参数描述、`output.render` 文本、错误 hint **全部中文**；技能正文与 `meta.title/description` 亦然。注：`enum` 的**取值**仍是 ASCII 机器值（`task`/`bug`/`create`），中文只出现在描述侧 |
| D4 | 是否要 Client UI | **设置页 + 看板** | 两期都做，故 Client 半是必需交付物；看板采用 §11.3 **路线 A**（`main` 全屏面板 + `sidebar.panellist` 入口），右侧栏路线 B 降为可选增强 |
| D5 | 认证方式 | **API Token** | 去掉账号密码授权流与 Cookie 记录；`ctx.authorization` 只注册一个 `token` 方法；配置里**没有**密码字段。设置页允许"用账号密码一次性换 token"，但密码即用即弃、绝不落盘 |
| D6 | 站点数量 | **单站点** | 配置扁平化（无 `sites[]`、无 `defaultSite`）；工具无 `site` 参数；凭据单键 `zentao/token`；缓存/游标不分站；**少一整类串号风险**（见 §7.3 的代价说明） |
| D7 | 子代理可否写 | **允许** | **删掉原"收窄子代理"设计**（原 §9.3）。代价必须补：新增两项并发写保护——① **同对象写串行化**（进程内按 `entity:id` 加队列，写同一对象不并发）；② **乐观并发校验**（写入前读 `version`，写入时带上，冲突返回 `CONFLICT` 而不是覆盖）。理由：并行子代理同时改同一对象会静默互相覆盖，这是放开的**必要对冲**，不能省 |

### 9.1 D7 带出的新要求（本轮新增的设计项）

原本"收窄子代理"承担的保护，现在必须由机制承担：

1. **同对象写串行化**：`key = entity + ':' + id`；同一 key 上的写操作进同一条串行队列，跨 key 并行。这保证"两个子代理抢着改同一个 Bug"变成排队而不是竞态。
2. **乐观并发校验**：禅道 v1 的实体载荷带 `version` 字段（已在任务响应实证看到 `"version": 1`）。写入时携带已读到的 `version`；服务端拒绝 → 映射为 `CONFLICT`，并让模型"先重读再决定"，**绝不自动重试覆盖**。
3. **读回去重**：写后强制回读比对（原本就有，现在从"好习惯"升级为"必需"）。
4. **删除类永远 ask**：不受 `writePolicy` 放宽——这条在多个写者并存时更重要。

> 这三条不改变工具面（无新参数、无新工具），只改变 L3 服务的并发语义，因此不会破坏 KV 缓存前缀。

---

## 10. 本文已核验 / 未核验清单

**已核验（源码或官方 README 级）**：§2 全表、`tools/pre-execute` 决策契约、`ask` 的 approval 解析与 fail-closed 行为、`Config` 的角色与 `.volatile()` 语义、`credentials` 两个域的方法签名、`authorization` 流程契约、`storageDomain` 读写语义、`commands`/`skills`/`sessionProjections`/`jobs` 的注册签名、`http-proxy` 的出网规则、客户端 `plugins.item` + `configForms` + `remote.credentials` 的用法、loader patch 方言与组合层级、包依赖解析规则。

**禅道侧已核验（官方手册英文镜像 + 开发者实测）**：取 token 的 `POST /api.php/v1/tokens` 与响应 `{token}`；请求头名 **`Token`**；列表响应信封 `{page,total,limit,<实体复数>}`；主要实体端点路径；REST v1 版本起点（开源 16.0+/专业 11.0+/企业 **6.0+**/旗舰 2.4+）；以及一批实测陷阱（状态代码与文档标签不一致、`0000-00-00` 假日期、UTC 时间、用户对象嵌套、id 为数字）。

**未核验（待 `02-detailed-design.md` §7.6 落地，必须对着真实实例跑一次）**：
1. **请求侧**分页与过滤参数名（`page`/`limit`/`q`/`assignedTo`/`status`）——响应侧信封已核验，请求侧未取得；
2. 网页深链格式（`bug-view-<id>.html` 之类）；
3. 错误体结构（业务错误是 200+body 还是 4xx+body、字段名）；
4. token 有效期与失效表现；
5. `legacy-api` 形态（已降级为可选，仅在探测梯 404 分支才需要）；
6. 企业版附加实体（反馈/工单）的实际可用性。
7. **槽位名的一处冲突**：官方模板用 `conversation.composer.dock`，而 `dsh-client-ui-conversation` 文档只列到 `conversation.input.dock`（composer 上方面板栈）。二者可能是同一座位的不同代名 —— 实现期第一步必须用 `cordis_inspect_query` 的 `Slots.listSubTree` 取**实时槽位表**再定，不猜；
8. `settings.section` / `settings.onboarding` / `settings.launcher` / `settings.general.item` 的精确注册字段与 props（README 只给语义，未给字段表）；
9. `dsh.client.immediately` 的确切语义（README 未定义，只能从 10 个引导类包都声明 `true` 反推为"启动即物化"）；
10. `locale/*.json` 的文件级约定：官方技能文档要求放在 `locale/{en,zh}.json`，而运行期只看"可解析到的 exported locale `meta`"（缺失回退 `package.json`）——实现期以一次真实装载验证。

---

## 附：本设计的"反模式"清单（实现时禁止）

1. ❌ 把 token/密码写进 `Config` 或 `cordis.patch.yml`。
2. ❌ 自建 undici `Agent`/`dispatcher`（静默绕过企业代理）。
3. ❌ 用 `ctx.session.append()` 写自定义事件类型（会话将无法重开）。
4. ❌ 在 UI 与工具里各写一套业务逻辑（DSH 明确要求一个操作一个实现）。
5. ❌ `require('@deepseek-ai/dsh-client-ui-primitives')` 或引入任何 Harness Client 包做 UI（非契约，且组件抛错会**整块槽位空白**，控制台报 `slot entry crashed`）。
6. ❌ 用 `<iframe>` 承载插件页面（拿不到宿主主题令牌与明暗切换）。
7. ❌ 硬编码颜色/像素：只能用 `--dsw-alias-*` 主题令牌，间距与字号抄同类型宿主页面。
8. ❌ 在 `session/event` 上重新扫描日志做统计（应使用 projection 单元）。
9. ❌ 把禅道返回的富文本原样灌进模型上下文（提示注入面）。
10. ❌ 自己改 profile 的 `package.json`/`cordis.patch.yml`（交给 `plugin_manager`）。
11. ❌ **在写路径上省掉同对象串行化与乐观并发校验**——已决定允许子代理写，这两项是对冲，不是可选优化（§9.1）。
12. ❌ 把密码写进凭据记录或配置（认证已定为 API Token；账号密码只允许"一次性换 token"且即用即弃）。
13. ❌ 工具 `description`/参数描述/错误 hint 写成英文（已定中文；只有 `name` 与 `enum` 机器值保持 ASCII）。
