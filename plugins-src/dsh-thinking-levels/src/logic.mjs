// 思考等级纯逻辑层:档位判定表、整组写回合并、冲突字段级重放、保存流(冲突重读
// 重放一次)。src/client.js 为单文件自包含格式(factory 仅解析 react),与本文件
// 保持同一份判定逻辑,修改须两处同步。

export const NS = 'llm-pi-ai'
export const CONFLICT_CODE = 'settings-conflict'
// 七个标准思考档位,与宿主 pi-ai THINKING_LEVELS 一致
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const OFF_LEVEL = 'off'

// reasoningEfforts 写回值 → 编辑器勾选/拼写草稿。
// false 仅勾 off(禁用推理);对象按键勾选,null 拼写为空;未声明无任何勾选。
// 只收词汇表内档位:词汇表外键不在 UI 呈现也不可编辑,进种子会让"未触及"
// 判定误判为已编辑。
export function effortsToDrafts(value) {
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

// 勾选/拼写草稿 → reasoningEfforts 写回值(undefined 表示删除字段)。
// 词汇表外的基线档位在对象形态下原样保留。
export function draftsToEfforts(drafts, baselineValue) {
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

// reasoningEfforts 基线的可表达形态:未声明(undefined)/ false / null / 纯对象。
// 其余(字符串、数组等异型形态)不参与档位重写,编辑时跳过该字段防误删。
export function isExpressibleEfforts(value) {
  return value === undefined || value === false || value === null
    || (typeof value === 'object' && !Array.isArray(value))
}

// 勾选/拼写两表逐键相等(键集合一致且值全等)
function draftMapsEqual(a, b) {
  const ak = Object.keys(a || {})
  const bk = Object.keys(b || {})
  if (ak.length !== bk.length) return false
  return ak.every((key) => (a || {})[key] === (b || {})[key])
}

// 单模型应用草稿:仅写 reasoningEfforts 字段,其余字段保留最新条目值。
// 未触及判定以草稿冻结的加载时点种子(draft.seed)为参照:加载后他方修改基线时,
// 零编辑的草稿不会把该字段静默回滚。无 seed 的裸草稿回退写回时点投影。
export function applyDraft(model, draft) {
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

// 模型条目形态:官方 schema 已拒绝非对象条目,此处守卫仅防手写 yaml 旁路输入。
function isModelEntry(model) {
  return model !== null && typeof model === 'object'
}

// 整组写回:以 describe 读到的模型数组为基线,仅重写有草稿的条目,未编辑条目
// 原样保留。非对象条目原样透传(保真不静默删数据);返回合并结果与未命中基线
// 的草稿 id(他方删除该模型后草稿无处可写),调用方负责告警。
export function mergeBaselineModels(baselineModels, draftsById) {
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

// settings 传输 → 插件内部 settings 面(describe() / mutate(ns, ops, revision))。
// 两种宿主传输形态:
// - typed remote 面(dsh 0.1.2+):方法直返 RemoteResult 信封 {ok,value|error};
// - connection.api 面(dsh 0.1.1+):单对象参数,返回 {rpcId,result:{ok,value|error}} 信封。
// 面缺失或形状不完整返回 null,由调用方降级呈现只读原因。
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

export function makeSettingsFace(transport) {
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

// describe 信封 → 本插件命名空间条目投影。namespaces 非数组按空表处理。
export function findNsEntry(value) {
  const namespaces = value !== null && typeof value === 'object' && Array.isArray(value.namespaces)
    ? value.namespaces
    : []
  return namespaces.find((entry) => entry !== null && typeof entry === 'object' && entry.ns === NS)
}

async function describeNs(settings) {
  const value = await settings.describe()
  const ns = findNsEntry(value)
  if (ns === undefined) throw new Error('settings 中不存在 ' + NS + ' 命名空间')
  // expectedRevision 为 undefined 时宿主跳过冲突检查即盲写,revision 缺失拒绝保存
  if (typeof ns.revision !== 'number') throw new Error('settings 未返回 revision,已拒绝盲写,请刷新页面重读')
  return { writable: value.writable === true, revision: ns.revision, value: ns.value }
}

export function modelsOf(nsValue, route) {
  const providers = nsValue && typeof nsValue === 'object' ? nsValue.providers : {}
  const provider = providers && typeof providers === 'object' ? providers[route] : undefined
  const models = provider && typeof provider === 'object' && Array.isArray(provider.models) ? provider.models : []
  // 非对象条目读侧过滤:手写 yaml 旁路输入不得让读侧迭代崩溃
  return models.filter((model) => model !== null && typeof model === 'object')
}

// 保存前基线形态校验:providers 缺失或 models 非数组时 modelsOf 会静默归空数组,
// 一次保存即把他方(或损坏)的整组模型覆写为空;此处拒绝保存。
export function assertWritableBaseline(nsValue, route) {
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

// 保存流:冲突重读重放一次,再冲突报错终止,绝不静默覆盖。
// 返回已写回的模型数组与未命中基线的草稿 id(模型已被他方删除,编辑未落盘)。
export async function saveModels(settings, route, draftsById) {
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
    // 重读发现已转只读:终态是只读而非冲突,抛只读语义而非原冲突错误
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

// 基线模型 → 可编辑草稿 Map(初值 = 当前声明)。seed 必须是**深拷贝**:它冻结
// 加载时点的勾选/拼写投影,作为"未触及"判定参照;若与草稿本体共享内层对象,
// 编辑会同步改写 seed,判定恒真、保存永远无效。键一律 String:基线 id 形态
// 不定,而 UI 侧的模型标识恒为字符串。
export function draftsFromModels(models) {
  const drafts = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    if (!isModelEntry(model)) continue
    // 先拷贝再分别引用:draft 本体与 seed 各持独立内层对象,编辑互不可见
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

// 一键草稿填充:只动内存草稿,写回仍走显式保存。仅补"未勾选任何档位"的模型
// (即 reasoningEfforts 未声明的手声明模型):七档全勾、拼写留空(线上值 = 档位名)。
// 已编辑(有勾选)的模型一律不碰,防覆盖既有声明。
export function fillDrafts(drafts, models) {
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

// 官方模型页标题标记(zh/en);精确匹配。
export function isModelsTitle(title) {
  return title === '模型' || title === 'Models'
}
