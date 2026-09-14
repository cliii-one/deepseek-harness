// 模型思考等级 Client 半区:官方模型页注入浮动入口,点开即完整编辑面板。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 纯客户端零 host 端:读写经 remote.settings 服务的 describe/mutate RPC,
// 信封由 makeSettingsFace 适配为插件内部 RPC 面。
// 判定逻辑与 src/logic.mjs 为同一份(单文件自包含格式无法跨文件 require),
// 修改须两处同步。

window.__ModuleLoader__.load({
  id: '@cliii-one/dsh-thinking-levels',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const { createRoot } = require('react-dom/client')

    /* LOGIC-BEGIN */
    // 纯逻辑段:与 src/logic.mjs 保持同一份判定逻辑,由 parity 测试保证。

    const NS = 'llm-pi-ai'
    const CONFLICT_CODE = 'settings-conflict'
    const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const OFF_LEVEL = 'off'

    function effortsToDrafts(value) {
      const checked = {}
      const spellings = {}
      if (value === false) {
        checked[OFF_LEVEL] = true
      } else if (value !== null && typeof value === 'object') {
        for (const level of Object.keys(value)) {
          if (EFFORT_LEVELS.indexOf(level) < 0) continue
          checked[level] = true
          spellings[level] = value[level] === null ? '' : String(value[level])
        }
      }
      return { checked, spellings }
    }

    function draftsToEfforts(drafts, baselineValue) {
      const checkedLevels = EFFORT_LEVELS.filter((level) => drafts.checked[level] === true)
      if (checkedLevels.length === 0) return undefined
      if (checkedLevels.length === 1 && checkedLevels[0] === OFF_LEVEL &&
          String(drafts.spellings[OFF_LEVEL] || '').trim().length === 0) return false
      const result = {}
      for (const level of Object.keys(baselineValue && typeof baselineValue === 'object' ? baselineValue : {})) {
        if (EFFORT_LEVELS.indexOf(level) < 0) result[level] = baselineValue[level]
      }
      for (const level of checkedLevels) {
        const spelling = String(drafts.spellings[level] || '').trim()
        if (level === OFF_LEVEL) {
          result[OFF_LEVEL] = spelling.length > 0 ? spelling : null
        } else {
          result[level] = spelling.length > 0 ? spelling : level
        }
      }
      return result
    }

    function isExpressibleEfforts(value) {
      return value === undefined || value === false || value === null
        || (typeof value === 'object' && !Array.isArray(value))
    }

    function draftMapsEqual(a, b) {
      const ak = Object.keys(a || {})
      const bk = Object.keys(b || {})
      if (ak.length !== bk.length) return false
      return ak.every((key) => (a || {})[key] === (b || {})[key])
    }

    function applyDraft(model, draft) {
      const result = { ...model }
      const seed = draft.seed !== undefined
        ? draft.seed
        : { ...effortsToDrafts(model.reasoningEfforts) }
      const effortsUntouched = draftMapsEqual(seed.checked, draft.checked) &&
        draftMapsEqual(seed.spellings, draft.spellings)
      if (!effortsUntouched && isExpressibleEfforts(model.reasoningEfforts)) {
        const efforts = draftsToEfforts(draft, model.reasoningEfforts)
        if (efforts === undefined) delete result.reasoningEfforts
        else result.reasoningEfforts = efforts
      }
      return result
    }

    function isModelEntry(model) {
      return model !== null && typeof model === 'object'
    }

    function mergeBaselineModels(baselineModels, draftsById) {
      const droppedDraftIds = []
      const models = baselineModels.map((model) => {
        const draft = isModelEntry(model) ? draftsById.get(String(model.id)) : undefined
        return draft === undefined ? model : applyDraft(model, draft)
      })
      for (const id of draftsById.keys()) {
        if (!baselineModels.some((model) => isModelEntry(model) && String(model.id) === String(id))) droppedDraftIds.push(id)
      }
      return { models, droppedDraftIds }
    }

    function unwrapEnvelope(envelope) {
      if (envelope !== null && typeof envelope === 'object' && envelope.ok === true) return envelope.value
      if (envelope !== null && typeof envelope === 'object' &&
          envelope.result !== null && typeof envelope.result === 'object') {
        if (envelope.result.ok === true) return envelope.result.value
        return rejectRpc(envelope.result.error)
      }
      return rejectRpc(envelope && envelope.error)
    }

    function rejectRpc(error) {
      const rpcError = new Error(error && error.message ? error.message : 'settings RPC 调用失败')
      rpcError.code = error ? error.code : undefined
      throw rpcError
    }

    function makeSettingsFace(transport) {
      if (transport === null || typeof transport !== 'object') return null
      const typed = typeof transport.describe === 'function' && typeof transport.mutate === 'function'
      if (typed) {
        return {
          describe: async () => unwrapEnvelope(await transport.describe()),
          mutate: async (ns, ops, expectedRevision) =>
            unwrapEnvelope(await transport.mutate(ns, ops, expectedRevision)),
        }
      }
      const api = transport.api
      if (api === null || typeof api !== 'object' ||
          api.settings === null || typeof api.settings !== 'object' ||
          typeof api.settings.describe !== 'function' || typeof api.settings.mutate !== 'function') return null
      return {
        describe: async () => unwrapEnvelope(await api.settings.describe({})),
        mutate: async (ns, ops, expectedRevision) =>
          unwrapEnvelope(await api.settings.mutate({
            ns,
            ops,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          })),
      }
    }

    function findNsEntry(value) {
      const namespaces = value !== null && typeof value === 'object' && Array.isArray(value.namespaces)
        ? value.namespaces
        : []
      return namespaces.find((entry) => entry !== null && typeof entry === 'object' && entry.ns === NS)
    }

    async function describeNs(settings) {
      const value = await settings.describe()
      const ns = findNsEntry(value)
      if (ns === undefined) throw new Error('settings 中不存在 ' + NS + ' 命名空间')
      if (typeof ns.revision !== 'number') throw new Error('settings 未返回 revision,已拒绝盲写,请刷新页面重读')
      return { writable: value.writable === true, revision: ns.revision, value: ns.value }
    }

    function modelsOf(nsValue, route) {
      const providers = nsValue && typeof nsValue === 'object' ? nsValue.providers : {}
      const provider = providers && typeof providers === 'object' ? providers[route] : undefined
      const models = provider && typeof provider === 'object' && Array.isArray(provider.models) ? provider.models : []
      return models.filter((model) => model !== null && typeof model === 'object')
    }

    function assertWritableBaseline(nsValue, route) {
      const providers = nsValue !== null && typeof nsValue === 'object' ? nsValue.providers : undefined
      if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
        throw new Error('llm-pi-ai 声明缺少 providers 对象,已拒绝保存,请刷新页面重读')
      }
      const provider = providers[route]
      if (provider === null || typeof provider !== 'object' || !Array.isArray(provider.models)) {
        throw new Error('provider ' + String(route) + ' 的 models 不是数组,已拒绝保存,请刷新页面重读')
      }
    }

    async function writeModels(settings, route, models, revision) {
      return settings.mutate(NS, [
        { op: 'set', path: ['providers', route, 'models'], value: models },
      ], revision)
    }

    async function saveModels(settings, route, draftsById) {
      const first = await describeNs(settings)
      if (!first.writable) {
        const error = new Error('settings 只读,无法保存')
        error.code = 'settings-readonly'
        throw error
      }
      assertWritableBaseline(first.value, route)
      const attempt = (baseline, revision) =>
        writeModels(settings, route, mergeBaselineModels(baseline, draftsById).models, revision)
      let baseline = modelsOf(first.value, route)
      let revision = first.revision
      try {
        await attempt(baseline, revision)
      } catch (error) {
        if (error.code !== CONFLICT_CODE) throw error
        const second = await describeNs(settings)
        if (!second.writable) {
          const readonlyError = new Error('settings 已转只读,保存终止,未覆盖他人改动')
          readonlyError.code = 'settings-readonly'
          throw readonlyError
        }
        assertWritableBaseline(second.value, route)
        baseline = modelsOf(second.value, route)
        revision = second.revision
        try {
          await attempt(baseline, revision)
        } catch (retryError) {
          if (retryError.code === CONFLICT_CODE) {
            const finalConflict = new Error('保存冲突:重试一次后仍与其他写者冲突,已保留本次修改,未覆盖他人改动')
            finalConflict.code = CONFLICT_CODE
            throw finalConflict
          }
          throw retryError
        }
      }
      return mergeBaselineModels(baseline, draftsById)
    }

    function draftsFromModels(models) {
      const drafts = new Map()
      for (const model of Array.isArray(models) ? models : []) {
        if (!isModelEntry(model)) continue
        // seed 必须深拷贝:与草稿本体共享内层对象会让"未触及"判定恒真,保存永远无效
        const efforts = effortsToDrafts(model.reasoningEfforts)
        drafts.set(String(model.id), {
          checked: { ...efforts.checked },
          spellings: { ...efforts.spellings },
          seed: {
            checked: { ...efforts.checked },
            spellings: { ...efforts.spellings },
          },
        })
      }
      return drafts
    }

    function fillDrafts(drafts, models) {
      const filled = new Map(drafts)
      for (const model of Array.isArray(models) ? models : []) {
        const key = String(model.id)
        const draft = filled.get(key)
        if (draft === undefined) continue
        const hasChecked = EFFORT_LEVELS.some((level) => draft.checked[level] === true)
        if (hasChecked) continue
        const checked = {}
        for (const level of EFFORT_LEVELS) checked[level] = true
        filled.set(key, { ...draft, checked, spellings: { ...draft.spellings } })
      }
      return filled
    }

    function isModelsTitle(title) {
      return title === '模型' || title === 'Models'
    }
    /* LOGIC-END */

    // ---------- UI ----------

    const CSS = [
      '.tl-card { display:flex; flex-direction:column; gap:10px; color:inherit; font-size:13px;',
      '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:10px; padding:12px; }',
      '.tl-head { display:flex; align-items:center; gap:8px; }',
      '.tl-head__title { font-weight:600; font-size:14px; }',
      '.tl-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
      '.tl-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
      '  background:transparent; color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
      '.tl-btn:hover { opacity:0.8; }',
      '.tl-btn:disabled { opacity:0.45; cursor:default; }',
      '.tl-btn--primary { background:var(--dsw-alias-brand-primary, #4d6bfe); border-color:transparent; color:#fff; }',
      '.tl-select { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
      '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:inherit; }',
      '.tl-text { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
      '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:inherit; width:90px; }',
      '.tl-model { display:flex; flex-direction:column; gap:4px; }',
      '.tl-model__head { font-weight:600; }',
      '.tl-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }',
      '.tl-check { display:inline-flex; align-items:center; gap:3px; font-size:12px; }',
      '.tl-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
      '.tl-switch { display:inline-flex; align-items:center; cursor:pointer; }',
      '.tl-switch__track { position:relative; width:34px; height:19px; border-radius:999px; box-sizing:border-box; flex:none;',
      '  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.35));',
      '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
      '  transition:background 0.15s, border-color 0.15s; }',
      '.tl-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%;',
      '  background:var(--dsw-alias-label-tertiary, rgba(128,128,128,0.6));',
      '  transform:translateY(-50%); transition:left 0.15s, background 0.15s; }',
      '.tl-switch input[type="checkbox"]:checked + .tl-switch__track { background:var(--dsw-alias-brand-primary, #4d6bfe); border-color:var(--dsw-alias-brand-primary, #4d6bfe); }',
      '.tl-switch input[type="checkbox"]:checked + .tl-switch__track .tl-switch__thumb { left:17px; background:var(--dsw-alias-bg-base, #fff); }',
      '.tl-switch input[type="checkbox"]:disabled + .tl-switch__track { opacity:0.45; cursor:default; }',
      '.tl-label { color:var(--dsw-alias-label-secondary); font-size:12px; }',
      '.tl-notice { font-size:12px; padding:4px 8px; border-radius:6px;',
      '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
      '.tl-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
      '.tl-spacer { flex:1; }',
      '.tl-panel { position:fixed; right:16px; top:50%; transform:translateY(-50%); z-index:60;',
      '  width:560px; max-width:calc(100vw - 32px); max-height:80vh; overflow:auto;',
      '  background:var(--dsw-alias-bg-primary, #fff);',
      '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:12px;',
      '  box-shadow:0 4px 24px rgba(0,0,0,0.18); padding:12px; }',
      '.tl-fab { position:fixed; right:16px; top:50%; transform:translateY(-50%); z-index:59;',
      '  box-shadow:0 2px 8px rgba(0,0,0,0.18); }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    function switchToggle(props) {
      return [
        h('input', { type: 'checkbox', ...props }),
        h('span', { className: 'tl-switch__track' }, h('span', { className: 'tl-switch__thumb' })),
      ]
    }

    function LevelEditor(props) {
      const draft = props.draft
      const disabled = props.disabled === true
      const toggle = (level) => {
        props.onChange({
          ...draft,
          checked: { ...draft.checked, [level]: draft.checked[level] !== true },
        })
      }
      const spell = (level, value) => {
        props.onChange({ ...draft, spellings: { ...draft.spellings, [level]: value } })
      }
      return h('div', { className: 'tl-row' },
        EFFORT_LEVELS.map((level) => h('label', { className: 'tl-check tl-switch', key: level },
          ...switchToggle({ disabled, checked: draft.checked[level] === true, onChange: () => toggle(level) }),
          level,
          h('input', {
            className: 'tl-text',
            disabled: disabled || draft.checked[level] !== true,
            value: draft.spellings[level] || '',
            placeholder: level === OFF_LEVEL ? '留空=不发送' : level,
            title: '发往网关的线上值',
            onChange: (event) => spell(level, event.target.value),
          }),
        )),
      )
    }

    function ModelRow(props) {
      const model = props.model
      const draft = props.draft
      const disabled = props.disabled === true
      const changeDraft = (next) => props.onChange(model.id, next)
      return h('div', { className: 'tl-model' },
        h('div', { className: 'tl-model__head' }, model.id, model.name && model.name !== model.id ? ' (' + model.name + ')' : ''),
        h('div', { className: 'tl-row' },
          h('span', { className: 'tl-label' }, '思考等级(勾选 = 提供,输入 = 线上拼写,留空 = 档位名):'),
          h(LevelEditor, { draft, disabled, onChange: changeDraft }),
        ),
      )
    }
    const MemoModelRow = React.memo(ModelRow)

    function ThinkingPanel(props) {
      const [state, setState] = useState({ phase: 'loading', reason: null, providers: null, route: null, models: null, drafts: null })
      const [saving, setSaving] = useState(false)
      const [open, setOpen] = useState(false)
      const bucketsRef = React.useRef(null)
      if (bucketsRef.current === null) bucketsRef.current = new Map()

      function patch(part) { setState((prev) => ({ ...prev, ...(typeof part === 'function' ? part(prev) : part) })) }

      const editDraft = useCallback((id, draft) => {
        setState((prev) => {
          const drafts = new Map(prev.drafts)
          drafts.set(String(id), draft)
          return { ...prev, drafts }
        })
      }, [])

      async function load() {
        try {
          const settings = props.settings
          if (!settings || typeof settings.describe !== 'function') {
            patch({ phase: 'readonly', reason: 'remote.settings 服务面缺失,无法读写模型声明' })
            return
          }
          const value = await settings.describe()
          if (value.writable !== true) {
            patch({ phase: 'readonly', reason: 'settings 当前只读,思考等级编辑不可用' })
            return
          }
          const ns = findNsEntry(value)
          if (ns === undefined) {
            patch({ phase: 'readonly', reason: 'settings 中不存在 ' + NS + ' 命名空间' })
            return
          }
          const providers = ns.value && typeof ns.value === 'object' ? ns.value.providers : {}
          const routes = Object.keys(providers && typeof providers === 'object' ? providers : {})
          const route = routes[0] !== undefined ? routes[0] : null
          patch({
            phase: 'ready',
            providers: routes,
            route,
            models: route === null ? [] : modelsOf(ns.value, route),
            drafts: route === null ? new Map() : draftsFromModels(modelsOf(ns.value, route)),
          })
        } catch (error) {
          patch({ phase: 'readonly', reason: '读取模型声明失败:' + (error && error.message ? error.message : String(error)) })
        }
      }

      useEffect(() => { void load() }, [])

      function selectRoute(nextRoute) {
        const seq = ++selectRoute.seq
        setSaving(true)
        patch({ route: nextRoute })
        void (async () => {
          try {
            const value = await props.settings.describe()
            if (seq !== selectRoute.seq) return
            const ns = findNsEntry(value)
            if (ns === undefined) { patch({ phase: 'readonly', reason: 'settings 中不存在 ' + NS + ' 命名空间' }); return }
            patch({
              models: modelsOf(ns.value, nextRoute),
              drafts: draftsFromModels(modelsOf(ns.value, nextRoute)),
            })
          } catch (error) {
            notify('读取 ' + nextRoute + ' 失败:' + (error && error.message ? error.message : String(error)), 'error')
          } finally {
            if (seq === selectRoute.seq) setSaving(false)
          }
        })()
      }

      async function save() {
        setSaving(true)
        try {
          const { droppedDraftIds } = await saveModels(props.settings, state.route, state.drafts)
          notify(droppedDraftIds.length > 0
            ? '已保存,但模型 ' + droppedDraftIds.join(', ') + ' 已被其他写者删除,对应修改未写入'
            : '已保存并写回 settings.yaml', droppedDraftIds.length > 0 ? 'error' : 'ok')
          try {
            const value = await props.settings.describe()
            const ns = findNsEntry(value)
            if (ns === undefined) { patch({ phase: 'readonly', reason: '保存后命名空间已消失,请刷新页面' }); return }
            patch({ models: modelsOf(ns.value, state.route), drafts: draftsFromModels(modelsOf(ns.value, state.route)) })
          } catch (refreshError) {
            notify('已保存,但刷新视图失败:' + (refreshError && refreshError.message ? refreshError.message : String(refreshError)), 'error')
          }
        } catch (error) {
          notify(error && error.message ? error.message : String(error), 'error')
        } finally {
          setSaving(false)
        }
      }

      if (!open) {
        return h('button', { className: 'tl-btn tl-fab', onClick: () => { setOpen(true); void load() } }, '思考等级')
      }
      if (state.phase === 'loading') {
        return h('div', { className: 'tl-panel' },
          h('div', { className: 'tl-head' },
            h('span', { className: 'tl-head__title' }, '模型思考等级'),
            h('span', { className: 'tl-spacer' }),
            h('button', { className: 'tl-btn', onClick: () => setOpen(false) }, '收起'),
          ),
          h('span', { className: 'tl-label' }, '正在读取模型声明…'))
      }
      if (state.phase === 'readonly') {
        return h('div', { className: 'tl-panel' },
          h('div', { className: 'tl-head' },
            h('span', { className: 'tl-head__title' }, '模型思考等级'),
            h('span', { className: 'tl-spacer' }),
            h('button', { className: 'tl-btn', onClick: () => setOpen(false) }, '收起'),
          ),
          h('div', { className: 'tl-notice tl-notice--error' }, state.reason))
      }
      return h('div', { className: 'tl-panel' },
        h('div', { className: 'tl-head' },
          h('span', { className: 'tl-head__title' }, '模型思考等级'),
          h('span', { className: 'tl-head__hint' }, '编辑 llm-pi-ai 管理的模型档位声明'),
          h('span', { className: 'tl-spacer' }),
          h('select', {
            className: 'tl-select',
            value: state.route || '',
            disabled: saving,
            onChange: (event) => selectRoute(event.target.value),
          }, state.providers.map((route) => h('option', { key: route, value: route }, route))),
          h('button', { className: 'tl-btn', onClick: () => setOpen(false) }, '收起'),
        ),
        state.models.map((model) => h(MemoModelRow, {
          key: model.id,
          model,
          draft: state.drafts.get(String(model.id)),
          disabled: saving,
          onChange: editDraft,
        })),
        state.models.length === 0
          ? h('div', { className: 'tl-label' }, '该 provider 暂无模型条目。')
          : null,
        h('div', { className: 'tl-row' },
          h('button', {
            className: 'tl-btn',
            disabled: saving || state.route === null,
            onClick: () => {
              const filled = fillDrafts(state.drafts, state.models)
              let count = 0
              for (const [id, draft] of filled) {
                if (state.drafts.get(id) !== draft) count += 1
              }
              if (count > 0) patch({ drafts: filled })
              notify(count > 0
                ? '已为 ' + count + ' 个未声明档位的模型填充草稿(七档全勾、线上值=档位名),检查后手动保存'
                : '没有需要填充的模型:所有模型均已声明档位', count > 0 ? 'ok' : 'error')
            },
          }, '填充草稿'),
          h('span', { className: 'tl-label' }, '仅填内存草稿,写回仍需手动保存。'),
        ),
        h('div', { className: 'tl-row' },
          h('button', { className: 'tl-btn tl-btn--primary', disabled: saving || state.route === null, onClick: save }, saving ? '保存中…' : '保存'),
          h('span', { className: 'tl-label' }, '保存 = 整组写回当前 provider 的 models 数组,未编辑的模型原样保留。'),
        ),
      )
    }

    function notify(text, kind) {
      console.log('[dsh-thinking-levels] ' + (kind === 'error' ? '[error] ' : '') + text)
    }

    return {
      // 声明两代宿主都具备的基座服务;settings 传输在 apply 内异步定面轮询
      inject: ['remote', 'connection'],
      apply(ctx) {
        let settings = null
        // 面板挂载点与 React root
        let panel = null
        let disposed = false
        let scanTimer = null
        let scanPending = false

        const FACE_POLL_INTERVAL_MS = 50
        const API_FACE_WAIT_MS = 1000
        const faceStartedAt = Date.now()
        const facePoll = () => {
          if (disposed) return
          const expired = Date.now() - faceStartedAt >= API_FACE_WAIT_MS
          try {
            settings = makeSettingsFace(ctx.connection)
            if (settings !== null) { scheduleScan(); return }
          } catch {
            // namespace/服务读取未就绪:按轮询节拍重试
          }
          if (expired) {
            console.warn('[dsh-thinking-levels] settings RPC 面不可用,编辑功能禁用')
            return
          }
          setTimeout(facePoll, FACE_POLL_INTERVAL_MS)
        }
        facePoll()

        function docInfo() {
          const outlet = document.querySelector('[data-slot="settings.section"]')
          if (outlet === null) return null
          const heading = outlet.querySelector('h2')
          const title = heading !== null ? heading.textContent : null
          return { outlet, titleMatched: isModelsTitle(title) }
        }

        // 样式表只注入一份,挂 document.head;清理时随插件生命周期移除
        function ensureStyle() {
          if (document.getElementById('tl-style') !== null) return
          const style = document.createElement('style')
          style.id = 'tl-style'
          style.textContent = CSS
          document.head.appendChild(style)
        }

        function disposePanel() {
          if (panel === null) return
          const { container, root } = panel
          panel = null
          root.unmount()
          container.remove()
        }

        function ensurePanel() {
          if (panel !== null) return
          const dialog = [...document.querySelectorAll('[role="dialog"]')]
            .find((node) => node.querySelector('[data-slot="settings.section"]') !== null)
          if (dialog === undefined) return
          ensureStyle()
          const container = document.createElement('div')
          container.className = 'tl-root'
          dialog.appendChild(container)
          const root = createRoot(container)
          root.render(React.createElement(ThinkingPanel, { settings }))
          panel = { container, root }
        }

        function reconcile() {
          if (disposed || settings === null) return
          // 已脱离文档的挂载点:官方页卸载或重建了对话框,释放对应 root
          if (panel !== null && !panel.container.isConnected) disposePanel()
          const info = docInfo()
          if (info === null || !info.titleMatched) { disposePanel(); return }
          ensurePanel()
        }

        function scheduleScan() {
          if (scanPending || disposed) return
          scanPending = true
          scanTimer = setTimeout(() => {
            scanPending = false
            if (document.querySelector('[data-slot="settings.section"]') !== null) reconcile()
          }, 150)
        }

        ctx.effect(() => {
          const observer = new MutationObserver(scheduleScan)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => {
            disposed = true
            if (scanTimer !== null) clearTimeout(scanTimer)
            observer.disconnect()
            disposePanel()
            const style = document.getElementById('tl-style')
            if (style !== null) style.remove()
          }
        }, 'thinking-levels: models-page panel')
      },
    }
  },
})
