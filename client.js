/**
 * Client 半：设置卡片 + 会话绑定的禅道卡片。
 *
 * 只用**已核验**的客户端机制（每一条都注明了证据来源）：
 *   · `window.__ModuleLoader__.load({ id, factory })`              官方装饰模板
 *   · `ctx.locale.register(ns, { zh, en })` / `bind(ns)`           两种内置语言必须齐全
 *   · `ctx.configForms.get(ns)` / `whileServed([ns], …)`           ui-settings 的作用域
 *   · `scope.getSnapshot()` → 作用域快照（值本身或其 `.value`）      ui-settings client.js
 *   · `scope.set(field, value)` / `unset(field)` / `mutate(ops, rev)` ui-settings client.js:1153-1181
 *     —— 操作形状 `{ op:'set'|'unset', path:[field], value }`
 *   · `ctx.remote.credentials.describe([ref])` → **RemoteResult**    ui-settings-web-search client.js:213
 *     —— 信封是 `{ ok, value: { [ref]: { configured, writable } } }`
 *   · `ctx.remote.credentials.set(ref, value)` → RemoteResult        同上:252
 *   · `ctx.remote.commands.execute(sessionId, line, attachments)`     ui-plan client.js:704
 *     —— 信封是 `{ ok, value?, error?{code,message} }`
 *   · 槽位注册 `inject: (sessionId) => ({...})` 拿到会话 id            ui-goal client.js:562
 *   · `sessions.binding(id).session.projections.faceOf(kind)`         ui-goal client.js:543
 *   · `ctx.slots.inject(id, () => ctx.slots.register(...))`           ui-workspace README
 *
 * 三条自我约束：
 *   1. **不 import 任何 Harness Client 包**（含 ui-primitives）：非契约，且组件抛错会让
 *      整个槽位空白。控件自己写，样式只用主题令牌（带 fallback）。
 *   2. 每个注册都包在 `ctx.effect` 里；任何一步失败只记录并跳过，绝不让插件把页面搞白。
 *   3. 数据取不到时显示**明确的空态**，不假装成功、也不渲染半个界面。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-zentao',
  factory (require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'zentao'
    /** 凭据引用名的默认值（与 Host 侧 src/auth.js 保持一致）。 */
    const DEFAULT_ACCOUNT_REF = 'ZENTAO_ACCOUNT'
    const DEFAULT_PASSWORD_REF = 'ZENTAO_PASSWORD'
    /** composer 上下文栈（ui-goal 的 strip 就在这座位）。用 slots.inject 注册，
     *  若该 id 在宿主里不存在，注册就永远不会发生 —— 失败模式是"没有卡片"，而不是崩。 */
    const DOCK_SLOT = 'conversation.input.dock'
    /** 全屏看板的主视图 key；侧栏入口的 id 必须与它相同（这是两者的关联方式）。 */
    const PANEL_KEY = `${NS}-board`

    const DICT = {
      zh: {
        title: '禅道 ZenTao',
        description: '查询与受控写入禅道的产品/需求/任务/Bug',
        connection: '站点地址',
        writePolicy: '写入策略',
        allowUnverified: '允许未校准的写操作（危险，默认关）',
        dialect: '接口方言',
        label: '站点名',
        credential: '登录账号与密码',
        configured: '已配置',
        notConfigured: '未配置',
        providedByEnv: '由进程环境变量提供（只读）',
        accountRef: '账号凭据名',
        passwordRef: '密码凭据名',
        account: '禅道账号',
        accountPlaceholder: '如 admin',
        password: '禅道密码',
        passwordPlaceholder: '留空则不修改',
        accountSaved: '账号已保存',
        passwordSaved: '密码已保存',
        saveCredentials: '保存账号与密码',
        credentialsHint: '账号与密码存在 DSH 凭据库里；插件用它们自动换取 API Token（Token 只在内存缓存、不落盘）。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        reload: '重新读取',
        loading: '读取中…',
        conflict: '配置已被其他页面改过，已重新读取，请确认后重试',
        memoryMode: '（Host 未提供持久化配置，本次改动可能不会保存）',
        unreadable: '（读不到当前配置：可能是 Host 端配置校验未通过，或本客户端版本与该作用域不匹配）',
        auto: '自动',
        board: '禅道',
        boardHint: '尚未设置禅道上下文。在对话里运行 /zentao switch（不带参数会列出所有产品与编号），再按编号或名称设置即可。',
        context: '当前上下文',
        product: '产品',
        execution: '执行',
        refresh: '刷新看板',
        running: '查询中…',
        needExecution: '请先 /zentao switch 设置执行，或在此填执行编号',
        executionId: '执行编号',
        askInChat: '已执行 /zentao board，结果请在对话里查看',
        collapse: '收起',
        expand: '展开',
        panelTitle: '禅道看板',
        noSession: '当前没有可用的会话（看板需要通过会话来执行 /zentao board）',
        reload: '同步上下文',
      },
      en: {
        title: 'ZenTao',
        description: 'Query and carefully write ZenTao products, stories, tasks and bugs',
        connection: 'Base URL',
        writePolicy: 'Write policy',
        allowUnverified: 'Allow uncalibrated writes (risky, off by default)',
        dialect: 'Dialect',
        label: 'Site label',
        credential: 'Account & password',
        configured: 'configured',
        notConfigured: 'not configured',
        providedByEnv: 'provided by the process environment (read-only)',
        accountRef: 'Account reference',
        passwordRef: 'Password reference',
        account: 'ZenTao account',
        accountPlaceholder: 'e.g. admin',
        password: 'ZenTao password',
        passwordPlaceholder: 'blank keeps it',
        accountSaved: 'Account saved',
        passwordSaved: 'Password saved',
        saveCredentials: 'Save account & password',
        credentialsHint: 'Stored in the DSH credential store; the plugin exchanges them for an API token that lives only in memory.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reload: 'Reload',
        loading: 'Loading…',
        conflict: 'The config changed elsewhere; it has been reloaded — review and retry',
        memoryMode: '(the host exposes no persistent config; this change may not be saved)',
        unreadable: '(cannot read the current config: the host may have rejected it, or this client version does not match the scope)',
        auto: 'auto',
        board: 'ZenTao',
        boardHint: 'No ZenTao context yet. Run /zentao switch with no arguments to list products (each with its id), then set one by id or name.',
        context: 'Current context',
        product: 'Product',
        execution: 'Execution',
        refresh: 'Refresh board',
        running: 'Querying…',
        needExecution: 'Set an execution via /zentao switch, or type one below',
        executionId: 'Execution id',
        askInChat: 'Ran /zentao board — see the chat for the result',
        collapse: 'Collapse',
        expand: 'Expand',
        panelTitle: 'ZenTao board',
        noSession: 'No usable session right now (the board runs /zentao board through a session)',
        reload: 'Sync context',
      },
    }

    /** 主题令牌统一带 fallback：令牌改名只会掉样式，不会让组件崩。 */
    const S = {
      card: { display: 'block', padding: '10px 4px', font: 'inherit', color: 'inherit' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0', flexWrap: 'wrap' },
      label: { minWidth: '9em', opacity: 0.75 },
      mono: { fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, monospace)', wordBreak: 'break-all' },
      input: {
        padding: '4px 6px', minWidth: '15em',
        border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,0.35))',
        borderRadius: '4px', background: 'transparent', color: 'inherit', font: 'inherit',
      },
      select: {
        padding: '4px 6px',
        border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,0.35))',
        borderRadius: '4px', background: 'transparent', color: 'inherit', font: 'inherit',
      },
      button: {
        padding: '4px 10px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,0.35))',
        borderRadius: '4px', background: 'transparent', color: 'inherit', font: 'inherit',
      },
      badge: (ok) => ({
        padding: '0 6px', borderRadius: '3px', fontSize: '0.9em',
        border: `1px solid ${ok ? 'var(--dsw-alias-status-success, #2f9e6f)' : 'var(--dsw-alias-border-base, rgba(128,128,128,0.35))'}`,
        color: ok ? 'var(--dsw-alias-status-success, #2f9e6f)' : 'inherit',
      }),
      hint: { marginTop: '8px', opacity: 0.75, fontSize: '0.95em' },
      error: { marginTop: '8px', color: 'var(--dsw-alias-status-error, #c0392b)', fontSize: '0.95em' },
      strip: {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', flexWrap: 'wrap',
        border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,0.35))',
        borderRadius: '6px', fontSize: '0.95em',
      },
      pre: {
        margin: '6px 0 0', padding: '8px', maxHeight: '16em', overflow: 'auto', whiteSpace: 'pre-wrap',
        border: '1px solid var(--dsw-alias-border-base, rgba(128,128,128,0.35))',
        borderRadius: '4px', fontSize: '0.9em',
      },
      /** 全屏看板页面的容器（主题令牌 + fallback，暗色下自动切换）。 */
      panel: {
        display: 'block', padding: '16px', font: 'inherit', color: 'inherit',
      },
      /** 侧栏入口图标：一个小方块，颜色同样只走主题令牌。 */
      panelIcon: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '1.25em', height: '1.25em', lineHeight: '1', fontSize: '0.95em',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-status-success, #2f9e6f)',
        color: 'var(--dsw-alias-status-success, #2f9e6f)',
      },
    }

    /** 作用域快照可能是"值本身"，也可能是带 `.value` 的包装。两种都接受。 */
    function readConfig (snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return undefined
      const inner = snapshot.value
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner
      return snapshot
    }

    /** RemoteResult → 值；失败返回 undefined 并把错误抛给调用方决定怎么显示。 */
    function unwrapRemote (result, what) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true) return result.value
        const message = result.error?.message ?? `${what}失败`
        const code = result.error?.code ? `（${result.error.code}）` : ''
        throw new Error(`${message}${code}`)
      }
      return result
    }

    /* ───────────────────── 设置卡片 ───────────────────── */

    function ZentaoCard (props) {
      const { t, ctx } = props
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [draft, setDraft] = React.useState({})
      const [accountRef, setAccountRef] = React.useState(DEFAULT_ACCOUNT_REF)
      const [passwordRef, setPasswordRef] = React.useState(DEFAULT_PASSWORD_REF)
      const [account, setAccount] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [accounts, setAccounts] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')

      const scope = React.useMemo(() => {
        try {
          return ctx.configForms.get(NS)
        } catch {
          return undefined
        }
      }, [ctx])

      // 首帧就把配置读出来（避免先闪一个空卡片），并顺手记下 CAS 版本号与可写性。
      // 已核验的快照形状（dsh-client-ui-settings/lib/client.js:1117-1125）：
      //   { status, value, base, user, revision, writable, mode }
      // 注意 `mode`（'host' | 'memory'）在**快照**上，不在 value 里。
      const { config, revision, mode, status, writable, readFailed } = React.useMemo(() => {
        try {
          const snapshot = scope?.getSnapshot?.()
          const found = readConfig(snapshot)
          return {
            config: found,
            revision: snapshot?.revision,
            mode: snapshot?.mode,
            status: snapshot?.status,
            writable: snapshot?.writable,
            readFailed: found === undefined,
          }
        } catch {
          return { config: undefined, readFailed: true }
        }
      }, [scope, refreshKey])
      // `memory` 表示 Host 不提供持久化：真实实现里 enqueue() 直接返回 false，
      // 也就是**所有写入都是空操作**。必须让用户看见，而不是显示"已保存"。
      const memoryOnly = mode === 'memory' || status === 'unavailable'

      const reload = React.useCallback(() => {
        setRefreshKey((key) => key + 1)
        setDraft({})
      }, [])

      /** 读两项凭据的**存在性**（凭据接口不返回值本体）。 */
      const readCredentials = React.useCallback(async () => {
        try {
          const result = await ctx.remote.credentials.describe([accountRef, passwordRef])
          const value = unwrapRemote(result, '读取凭据状态') ?? {}
          setAccounts({
            account: value[accountRef] ?? { configured: false },
            password: value[passwordRef] ?? { configured: false },
          })
        } catch {
          setAccounts({
            account: { configured: false, writable: false, unknown: true },
            password: { configured: false, writable: false, unknown: true },
          })
        }
      }, [ctx, accountRef, passwordRef])

      React.useEffect(() => {
        if (config && typeof config.accountRef === 'string' && config.accountRef) setAccountRef(config.accountRef)
        if (config && typeof config.passwordRef === 'string' && config.passwordRef) setPasswordRef(config.passwordRef)
      }, [config])

      React.useEffect(() => { readCredentials() }, [readCredentials])

      React.useEffect(() => {
        // 其他页面改了配置时跟随刷新（subscribe 是否可用的判断是防御性的）
        try {
          const unsubscribe = scope?.subscribe?.(() => reload())
          return typeof unsubscribe === 'function' ? unsubscribe : undefined
        } catch {
          return undefined
        }
      }, [scope, reload])

      const saveField = async (field, value) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          if (typeof scope?.set !== 'function') {
            throw new Error('当前客户端没有暴露配置写入接口（scope.set 不存在）')
          }
          // 已核验契约（同文件 :1152-1194）：set/unset/mutate 返回**布尔值** ——
          // "Host 是否接受了这次写入，且在失败时已自行做过恢复读取"。
          // 因此非 true 一律视为**未保存**：绝不能因为"没抛异常"就报告成功。
          const accepted = await scope.set(field, value)
          if (accepted !== true) {
            reload()
            setNotice(memoryOnly ? t('memoryMode') : t('conflict'))
            return
          }
          setNotice(t('saved'))
          reload()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 保存账号与密码：两者都写进 DSH 凭据库（`remote.credentials.set(ref, value)`），
       * 密码框留空表示不修改。**不回显任何已保存的值**（凭据接口只报告存在性）。
       */
      const saveCredentials = async () => {
        const accountText = account.trim()
        const passwordText = password.trim()
        if (accountText === '' && passwordText === '') return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const done = []
          if (accountText !== '') {
            await unwrapRemote(await ctx.remote.credentials.set(accountRef, accountText), '保存账号')
            done.push(t('accountSaved'))
          }
          if (passwordText !== '') {
            await unwrapRemote(await ctx.remote.credentials.set(passwordRef, passwordText), '保存密码')
            done.push(t('passwordSaved'))
          }
          setAccount('')
          setPassword('')
          await readCredentials()
          setNotice(done.join('；'))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const field = (key, label, kind = 'text', options) => {
        const current = draft[key] !== undefined ? draft[key] : (config?.[key] ?? '')
        const onChange = (event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))
        const control = options
          ? h('select', { style: S.select, value: current, onChange },
            ...options.map((option) => h('option', { key: option, value: option }, option)))
          : h('input', { style: S.input, value: current, onChange, spellCheck: false })
        const dirty = draft[key] !== undefined && draft[key] !== (config?.[key] ?? '')
        return h('div', { style: S.row, key },
          h('span', { style: S.label }, label),
          control,
          h('button', {
            style: S.button,
            // writable === false 时 Host 明确不接受写入，按钮就不该是可点的
            disabled: busy || !dirty || writable === false,
            onClick: () => saveField(key, current),
          }, t('save')),
        )
      }

      /** 布尔字段（复选框）：只用于"确实要打开"的危险开关。 */
      const booleanField = (key, label) => {
        const saved = Boolean(config?.[key])
        const current = draft[key] !== undefined ? draft[key] : saved
        const dirty = draft[key] !== undefined && draft[key] !== saved
        return h('div', { style: S.row, key },
          h('span', { style: S.label }, label),
          h('input', {
            type: 'checkbox',
            checked: current,
            onChange: (event) => setDraft((prev) => ({ ...prev, [key]: event.target.checked })),
          }),
          h('button', {
            style: S.button,
            disabled: busy || !dirty,
            onClick: () => saveField(key, current),
          }, t('save')),
        )
      }

      const credentialText = (info) => (info === undefined
        ? t('loading')
        : info.configured
          ? (info.writable === false ? t('providedByEnv') : t('configured'))
          : t('notConfigured'))

      // 没有配置值时的占位文案要区分原因（真实实现 dsh-client-ui-settings/lib/client.js:1235-1254）：
      //   · status 'loading' + value undefined → 还在读，或**Host 端 schema 校验未通过**（decode 返回 undefined）
      //   · status 'unavailable'             → 该作用域当前不可用（Host 未提供持久化）
      const placeholder = readFailed
        ? (status === 'loading' ? t('loading') : t('unreadable'))
        : '—'

      return h('div', { style: S.card },
        h('div', { style: S.row },
          h('span', { style: S.label }, t('connection')),
          h('span', { style: S.mono }, config?.baseURL ?? placeholder),
        ),
        field('label', t('label')),
        field('baseURL', t('connection')),
        field('writePolicy', t('writePolicy'), 'select', ['readonly', 'confirm', 'trusted']),
        booleanField('allowUnverifiedWrites', t('allowUnverified')),
        field('dialect', t('dialect'), 'select', ['auto', 'rest-v1', 'rest-v2', 'legacy-api']),
        memoryOnly ? h('div', { style: S.hint }, t('memoryMode')) : null,
        h('div', { style: S.row },
          h('span', { style: S.label }, t('credential')),
          h('span', { style: S.badge(Boolean(accounts?.account?.configured)) },
            `${t('account')}：${credentialText(accounts?.account)}`),
          h('span', { style: S.badge(Boolean(accounts?.password?.configured)) },
            `${t('password')}：${credentialText(accounts?.password)}`),
        ),
        h('div', { style: S.hint }, t('credentialsHint')),
        h('div', { style: S.row },
          h('span', { style: S.label }, t('account')),
          h('input', {
            style: S.input, value: account, spellCheck: false,
            placeholder: t('accountPlaceholder'), autoComplete: 'off',
            onChange: (event) => setAccount(event.target.value),
          }),
          h('span', { style: S.label }, t('accountRef')),
          h('input', { style: S.input, value: accountRef, spellCheck: false, onChange: (event) => setAccountRef(event.target.value) }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, t('password')),
          h('input', {
            style: S.input, type: 'password', value: password,
            autoComplete: 'new-password', spellCheck: false,
            placeholder: t('passwordPlaceholder'),
            onChange: (event) => setPassword(event.target.value),
          }),
          h('span', { style: S.label }, t('passwordRef')),
          h('input', { style: S.input, value: passwordRef, spellCheck: false, onChange: (event) => setPasswordRef(event.target.value) }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, ''),
          h('button', {
            style: S.button,
            disabled: busy || (account.trim() === '' && password.trim() === ''),
            onClick: saveCredentials,
          }, busy ? t('saving') : t('saveCredentials')),
          h('button', { style: S.button, onClick: () => { reload(); readCredentials() } }, t('reload')),
        ),
        notice ? h('div', { style: S.hint }, notice) : null,
        error ? h('div', { style: S.error }, error) : null,
        revision !== undefined ? h('div', { style: S.hint }, `revision ${revision}`) : null,
      )
    }

    /* ───────────────────── 会话绑定的禅道卡片 ───────────────────── */

    /** 读取 Host 注册的会话投影（`zentaoContext`）。取不到就是空态，不抛。 */
    function readProjection (sessions, sessionId) {
      try {
        const binding = sessions?.binding?.(sessionId)
        const face = binding?.session?.projections?.faceOf?.('zentaoContext')
        return face?.getSnapshot?.() ?? undefined
      } catch {
        return undefined
      }
    }

    /** 从 commands.execute 的返回里尽力取出可读文本（形状做容错）。 */
    function extractText (value) {
      if (value === undefined || value === null) return undefined
      if (typeof value === 'string') return value
      const candidates = [value.result?.text, value.text, value.result?.message, value.message]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
      }
      return undefined
    }

    function ZentaoDock (props) {
      const { t, ctx, sessionId } = props
      const [context, setContext] = React.useState(() => readProjection(ctx.sessions, sessionId))
      const [execution, setExecution] = React.useState('')
      const [output, setOutput] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [open, setOpen] = React.useState(false)

      React.useEffect(() => {
        // 投影随会话日志变化；这里只在挂载与手动刷新时读，不做订阅（订阅形状未核验）
        setContext(readProjection(ctx.sessions, sessionId))
      }, [ctx, sessionId])

      const effectiveExecution = execution.trim() !== ''
        ? execution.trim()
        : (context?.executionId ?? '')

      const runBoard = async () => {
        if (effectiveExecution === '') {
          setError(t('needExecution'))
          return
        }
        setBusy(true)
        setError('')
        try {
          const result = await ctx.remote.commands.execute(
            sessionId, `/zentao board ${effectiveExecution}`, [],
          )
          const value = unwrapRemote(result, '执行 /zentao board')
          if (value === undefined) throw new Error('unknown command: /zentao board')
          setOutput(extractText(value) ?? t('askInChat'))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      const hasContext = Boolean(context?.productId || context?.executionId)
      if (!open) {
        // 折叠态：只在有上下文时露出一条细带，避免长期占据 composer 上方的纵向空间
        if (!hasContext) return null
        return h('div', { style: S.strip },
          h('span', { style: S.badge(true) }, t('board')),
          h('span', null, `${t('product')} ${context.productTitle ?? context.productId ?? '—'}`),
          h('span', null, `${t('execution')} ${context.executionId ?? '—'}`),
          h('button', { style: S.button, onClick: () => { setOpen(true); setContext(readProjection(ctx.sessions, sessionId)) } },
            t('expand')),
        )
      }

      return h('div', { style: S.strip },
        h('div', { style: { display: 'block', width: '100%' } },
          h('div', { style: S.row },
            h('span', { style: S.badge(hasContext) }, t('board')),
            hasContext
              ? h('span', null, `${t('context')}：${t('product')} ${context.productTitle ?? context.productId ?? '—'} / ${t('execution')} ${context.executionId ?? '—'}`)
              : h('span', { style: S.hint }, t('boardHint')),
            h('button', { style: S.button, onClick: () => setOpen(false) }, t('collapse')),
          ),
          h('div', { style: S.row },
            h('span', { style: S.label }, t('executionId')),
            h('input', {
              style: S.input, value: execution, spellCheck: false,
              placeholder: context?.executionId ?? '',
              onChange: (event) => setExecution(event.target.value),
            }),
            h('button', { style: S.button, disabled: busy, onClick: runBoard },
              busy ? t('running') : t('refresh')),
          ),
          output ? h('pre', { style: S.pre }, output) : null,
          error ? h('div', { style: S.error }, error) : null,
        ),
      )
    }

    /**
     * 当前**主视图**的会话 id（全局面板用；`main` 槽位拿不到 slot props 里的 sessionId）。
     *
     * 依据真实实现 `dsh-client-ui-session/lib/client.js:281-285,340,344`：
     *   · `sessions.list.getSnapshot().byId` 列出会话；
     *   · `sessions.retainInfo(id).getSnapshot().retainedBy.mainView > 0` 表示该会话正占据主视图。
     * 取不到就返回 undefined —— 面板显示空态，绝不抛（抛错会让整个槽位空白）。
     */
    function mainSessionId (sessions) {
      try {
        const byId = sessions?.list?.getSnapshot?.()?.byId ?? {}
        const ids = Object.keys(byId)
        for (const id of ids) {
          const retained = sessions?.retainInfo?.(id)?.getSnapshot?.()?.retainedBy?.mainView ?? 0
          if (retained > 0) return id
        }
        // 兜底：只有一个会话时它显然就是当前的
        return ids.length === 1 ? ids[0] : undefined
      } catch {
        return undefined
      }
    }

    /** 全屏看板页面。数据全部通过已核验的 `/zentao board` 命令取得，不依赖 Host Remote 命名空间。 */
    function ZentaoBoardPanel (props) {
      const { t, ctx } = props
      const [sessionId, setSessionId] = React.useState(() => mainSessionId(ctx.sessions))
      const [context, setContext] = React.useState(() => readProjection(ctx.sessions, mainSessionId(ctx.sessions)))
      const [target, setTarget] = React.useState('')
      const [output, setOutput] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [open, setOpen] = React.useState(true)

      const resync = () => {
        const id = mainSessionId(ctx.sessions)
        setSessionId(id)
        setContext(readProjection(ctx.sessions, id))
      }
      const effectiveTarget = target.trim() !== '' ? target.trim() : String(context?.executionId ?? '')

      const run = async () => {
        if (!sessionId) { setError(t('noSession')); return }
        if (effectiveTarget === '') { setError(t('needExecution')); return }
        setBusy(true)
        setError('')
        try {
          const result = await ctx.remote.commands.execute(sessionId, `/zentao board ${effectiveTarget}`, [])
          const value = unwrapRemote(result, '执行 /zentao board')
          if (value === undefined) throw new Error('unknown command: /zentao board')
          setOutput(extractText(value) ?? t('askInChat'))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      if (!open) {
        return h('div', { style: S.row },
          h('button', { style: S.button, onClick: () => { resync(); setOpen(true) } }, t('expand')),
        )
      }

      return h('div', { style: S.panel },
        h('div', { style: S.row },
          h('span', { style: S.badge(Boolean(context?.executionId || context?.productId)) }, t('panelTitle')),
          h('span', { style: S.label }, `${t('context')}：${t('product')} ${context?.productTitle ?? context?.productId ?? '—'} / ${t('execution')} ${context?.executionId ?? '—'}`),
          h('button', { style: S.button, onClick: resync }, t('reload')),
          h('button', { style: S.button, onClick: () => setOpen(false) }, t('collapse')),
        ),
        context?.productId || context?.executionId
          ? null
          : h('div', { style: S.hint }, t('boardHint')),
        h('div', { style: S.row },
          h('span', { style: S.label }, t('executionId')),
          h('input', {
            style: S.input, value: target, spellCheck: false,
            placeholder: String(context?.executionId ?? ''),
            onChange: (event) => setTarget(event.target.value),
          }),
          h('button', { style: S.button, disabled: busy, onClick: run }, busy ? t('running') : t('refresh')),
        ),
        output ? h('pre', { style: S.pre }, output) : null,
        error ? h('div', { style: S.error }, error) : null,
      )
    }

    /** 侧栏入口里的图标（`sidebar.panellist` 的组件）。绝不抛错。 */
    function ZentaoPanelIcon () {
      return h('span', { style: S.panelIcon, title: '禅道' }, '禅')
    }

    return {
      // 注入名必须是**真实存在的服务名**。注意：用 `ctx.remote.*` 之前，**顶层 `remote` 必须
      // 一起声明** —— 只写 `remote.credentials` / `remote.commands` 会在访问 `ctx.remote` 时抛
      // `cannot get property "remote" without inject`（真机踩过）。
      // 真实写法参考 dsh-client-ui-settings/lib/client.js:1503：`["remote", "remote.settings"]`。
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.credentials', 'remote.commands', 'sessions'],
      apply (ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, DICT), 'zentao: locale dictionary')

        // 设置卡片：挂成"官方插件"页里的一张卡
        ctx.effect(() => ctx.configForms.whileServed([NS], () =>
          ctx.slots.inject('plugins.item', () =>
            ctx.slots.register(
              { name: 'plugins.item', id: NS, locale: NS, label: () => t('title') },
              (props) => h(ZentaoCard, { ...props, t, ctx }),
            ))), 'zentao: settings card')

        // 会话绑定的禅道卡片：`inject(sessionId)` 是已核验的取会话 id 方式
        ctx.effect(() => ctx.slots.inject(DOCK_SLOT, () =>
          ctx.slots.register(
            {
              name: DOCK_SLOT,
              id: `${NS}-dock`,
              locale: NS,
              inject: (sessionId) => ({ sessionId }),
            },
            (props) => h(ZentaoDock, { ...props, t, ctx }),
          )), 'zentao: session dock card')

        // 全屏看板 + 侧栏入口。
        // 形状取自真实实现 dsh-client-ui-schedule/lib/client.js:6793-6810：
        //   · `main` 用 **key**；· `sidebar.panellist` 用 **id**，且 id 必须等于 main 的 key（这就是关联方式）。
        // 两者都用 slots.inject：宿主里没有该槽位时注册不会发生（失败模式是"没有入口"，不会崩）。
        ctx.effect(() => ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_KEY, locale: NS },
            (props) => h(ZentaoBoardPanel, { ...props, t, ctx }),
          )), 'zentao: board panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_KEY,
              order: 40,
              locale: NS,
              label: () => t('panelTitle'),
            },
            (props) => h(ZentaoPanelIcon, { ...props, t, ctx }),
          )), 'zentao: board sidebar entry')
      },
    }
  },
})
