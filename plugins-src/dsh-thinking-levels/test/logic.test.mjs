// 思考等级纯逻辑层单测:档位判定表、整组写回合并、冲突重放、settings 面适配。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFORT_LEVELS, OFF_LEVEL,
  effortsToDrafts, draftsToEfforts, isExpressibleEfforts, applyDraft,
  mergeBaselineModels, makeSettingsFace, findNsEntry, modelsOf,
  assertWritableBaseline, draftsFromModels, fillDrafts, isModelsTitle,
  saveModels,
} from '../src/logic.mjs'

// ---------- effortsToDrafts ----------

test('effortsToDrafts: false 仅勾 off', () => {
  const d = effortsToDrafts(false)
  assert.equal(d.checked.off, true)
  assert.equal(Object.keys(d.checked).length, 1)
})

test('effortsToDrafts: 对象形态按键勾选,null 拼写为空', () => {
  const d = effortsToDrafts({ high: 'ultra', low: null })
  assert.deepEqual(d.checked, { high: true, low: true })
  assert.equal(d.spellings.high, 'ultra')
  assert.equal(d.spellings.low, '')
})

test('effortsToDrafts: 词汇表外档位不进草稿', () => {
  const d = effortsToDrafts({ custom: 'x', high: null })
  assert.deepEqual(d.checked, { high: true })
})

test('effortsToDrafts: 未声明无勾选', () => {
  assert.deepEqual(effortsToDrafts(undefined).checked, {})
})

// ---------- draftsToEfforts ----------

test('draftsToEfforts: 全不勾 = 删除字段(undefined)', () => {
  assert.equal(draftsToEfforts({ checked: {}, spellings: {} }, undefined), undefined)
})

test('draftsToEfforts: 仅勾 off 且拼写留空 = false(禁用推理)', () => {
  assert.equal(draftsToEfforts({ checked: { off: true }, spellings: { off: '' } }, undefined), false)
})

test('draftsToEfforts: off 勾选拼写留空 + 其他档 = off:null', () => {
  const v = draftsToEfforts(
    { checked: { off: true, high: true }, spellings: { off: '', high: '' } },
    undefined,
  )
  assert.equal(v.off, null)
  assert.equal(v.high, 'high')
})

test('draftsToEfforts: 非 off 档拼写留空 = 档位名自映射', () => {
  const v = draftsToEfforts({ checked: { high: true }, spellings: { high: '' } }, undefined)
  assert.deepEqual(v, { high: 'high' })
})

test('draftsToEfforts: 拼写填值 = 线上重命名', () => {
  const v = draftsToEfforts({ checked: { high: true }, spellings: { high: 'ultra' } }, undefined)
  assert.deepEqual(v, { high: 'ultra' })
})

test('draftsToEfforts: 词汇表外基线档位原样保留', () => {
  const v = draftsToEfforts({ checked: { high: true }, spellings: { high: '' } }, { custom: 'x' })
  assert.deepEqual(v, { custom: 'x', high: 'high' })
})

// ---------- isExpressibleEfforts ----------

test('isExpressibleEfforts: 未声明/false/null/对象可表达,字符串/数组不可', () => {
  assert.equal(isExpressibleEfforts(undefined), true)
  assert.equal(isExpressibleEfforts(false), true)
  assert.equal(isExpressibleEfforts(null), true)
  assert.equal(isExpressibleEfforts({ high: 'u' }), true)
  assert.equal(isExpressibleEfforts('high'), false)
  assert.equal(isExpressibleEfforts(['high']), false)
})

// ---------- applyDraft / mergeBaselineModels ----------

test('applyDraft: 未触及草稿不回滚字段', () => {
  const model = { id: 'm1', reasoningEfforts: { high: 'ultra' } }
  const draft = { ...draftsFromModels([model]).get('m1') }
  const out = applyDraft(model, draft)
  assert.deepEqual(out.reasoningEfforts, { high: 'ultra' })
})

test('applyDraft: 改动档位写回,其余字段保留', () => {
  const model = { id: 'm1', contextWindow: 8192, reasoningEfforts: { high: 'ultra' } }
  const draft = draftsFromModels([model]).get('m1')
  draft.checked.high = false
  draft.checked.low = true
  const out = applyDraft(model, draft)
  assert.deepEqual(out.reasoningEfforts, { low: 'low' })
  assert.equal(out.contextWindow, 8192)
})

test('applyDraft: 异型基线(字符串)不参与重写防误删', () => {
  const model = { id: 'm1', reasoningEfforts: 'bogus' }
  const draft = { checked: { high: true }, spellings: { high: '' } }
  const out = applyDraft(model, draft)
  assert.equal(out.reasoningEfforts, 'bogus')
})

test('mergeBaselineModels: 未编辑条目原样保留,孤儿草稿上报', () => {
  const baseline = [{ id: 'a', x: 1 }, { id: 'b', y: 2 }]
  const drafts = new Map([['gone', { checked: {}, spellings: {}, seed: { checked: {}, spellings: {} } }]])
  const { models, droppedDraftIds } = mergeBaselineModels(baseline, drafts)
  assert.equal(models[0].x, 1)
  assert.equal(models[1].y, 2)
  assert.deepEqual(droppedDraftIds, ['gone'])
})

test('mergeBaselineModels: 非对象条目原样透传', () => {
  const baseline = ['bogus', { id: 'a' }]
  const { models } = mergeBaselineModels(baseline, new Map())
  assert.deepEqual(models, ['bogus', { id: 'a' }])
})

// ---------- settings 面与保存流 ----------

test('makeSettingsFace: typed remote 面 describe/mutate 直返 value', async () => {
  const calls = []
  const face = makeSettingsFace({
    describe: async () => ({ ok: true, value: 'D' }),
    mutate: async (ns, ops, rev) => { calls.push([ns, ops, rev]); return { ok: true, value: 'M' } },
  })
  assert.equal(await face.describe(), 'D')
  assert.equal(await face.mutate('ns', [], 3), 'M')
  assert.deepEqual(calls, [['ns', [], 3]])
})

test('makeSettingsFace: api 信封面拆包 result', async () => {
  const face = makeSettingsFace({
    api: { settings: {
      describe: async () => ({ rpcId: 1, result: { ok: true, value: 'D' } }),
      mutate: async () => ({ rpcId: 2, result: { ok: false, error: { code: 'settings-conflict', message: 'x' } } }),
    } },
  })
  assert.equal(await face.describe(), 'D')
  await assert.rejects(() => face.mutate('ns', [], 1), (e) => e.code === 'settings-conflict')
})

test('makeSettingsFace: 面缺失返回 null', () => {
  assert.equal(makeSettingsFace(null), null)
  assert.equal(makeSettingsFace({}), null)
  assert.equal(makeSettingsFace({ api: {} }), null)
})

test('findNsEntry / modelsOf: 命名空间与模型投影', () => {
  const value = { writable: true, namespaces: [
    { ns: 'llm-pi-ai', revision: 7, value: { providers: { r1: { models: [{ id: 'm' }, 'bogus'] } } } },
  ] }
  const ns = findNsEntry(value)
  assert.equal(ns.revision, 7)
  assert.deepEqual(modelsOf(ns.value, 'r1'), [{ id: 'm' }])
  assert.deepEqual(modelsOf(ns.value, 'nope'), [])
})

test('assertWritableBaseline: providers 缺失拒绝保存', () => {
  assert.throws(() => assertWritableBaseline({}, 'r'), /providers/)
  assert.throws(() => assertWritableBaseline({ providers: { r: { models: 'x' } } }, 'r'), /不是数组/)
})

test('saveModels: 冲突重读重放一次后成功', async () => {
  let rev = 1
  let calls = 0
  // typed remote 面语义:直返 value,失败以 RemoteError 抛出(信封由面适配层拆)
  const settings = {
    describe: async () => ({ writable: true, namespaces: [
      { ns: 'llm-pi-ai', revision: rev, value: { providers: { r: { models: [{ id: 'm' }] } } } },
    ] }),
    mutate: async (ns, ops, expected) => {
      calls += 1
      if (calls === 1 && expected === 1) {
        rev = 2
        throw Object.assign(new Error('stale'), { code: 'settings-conflict' })
      }
      assert.equal(expected, 2)
      return null
    },
  }
  const drafts = draftsFromModels([{ id: 'm' }])
  drafts.get('m').checked.high = true
  const { models } = await saveModels(settings, 'r', drafts)
  assert.equal(models[0].reasoningEfforts.high, 'high')
  assert.equal(calls, 2)
})

test('saveModels: 二次冲突终止,绝不静默覆盖', async () => {
  const settings = {
    describe: async () => ({ writable: true, namespaces: [
      { ns: 'llm-pi-ai', revision: 1, value: { providers: { r: { models: [{ id: 'm' }] } } } },
    ] }),
    mutate: async () => { throw Object.assign(new Error('stale'), { code: 'settings-conflict' }) },
  }
  const drafts = draftsFromModels([{ id: 'm' }])
  drafts.get('m').checked.high = true
  await assert.rejects(() => saveModels(settings, 'r', drafts), /冲突/)
})

test('saveModels: api 信封面端到端冲突重放', async () => {
  // 0.1.1 connection.api 面:transport 返回 {rpcId,result} 信封,由面适配层拆包
  let calls = 0
  const settings = makeSettingsFace({
    api: { settings: {
      describe: async () => ({ rpcId: 1, result: { ok: true, value: { writable: true, namespaces: [
        { ns: 'llm-pi-ai', revision: 1, value: { providers: { r: { models: [{ id: 'm' }] } } } },
      ] } } }),
      mutate: async () => {
        calls += 1
        return calls === 1
          ? { rpcId: 2, result: { ok: false, error: { code: 'settings-conflict', message: 'stale' } } }
          : { rpcId: 3, result: { ok: true, value: null } }
      },
    } },
  })
  const drafts = draftsFromModels([{ id: 'm' }])
  drafts.get('m').checked.high = true
  const { models } = await saveModels(settings, 'r', drafts)
  assert.equal(models[0].reasoningEfforts.high, 'high')
  assert.equal(calls, 2)
})

test('saveModels: 只读拒绝', async () => {
  const settings = {
    describe: async () => ({ writable: false, namespaces: [
      { ns: 'llm-pi-ai', revision: 1, value: { providers: { r: { models: [] } } } },
    ] }),
    mutate: async () => { throw new Error('不应被调用') },
  }
  await assert.rejects(() => saveModels(settings, 'r', new Map()), /只读/)
})

// ---------- fillDrafts / isModelsTitle ----------

test('fillDrafts: 仅补未声明档位的模型', () => {
  const models = [{ id: 'a' }, { id: 'b', reasoningEfforts: { high: 'u' } }]
  const drafts = draftsFromModels(models)
  const filled = fillDrafts(drafts, models)
  assert.equal(Object.keys(filled.get('a').checked).length, EFFORT_LEVELS.length)
  assert.equal(Object.keys(filled.get('b').checked).length, 1)
})

test('isModelsTitle: 精确匹配 zh/en', () => {
  assert.equal(isModelsTitle('模型'), true)
  assert.equal(isModelsTitle('Models'), true)
  assert.equal(isModelsTitle('模型能力'), false)
})

test('OFF_LEVEL 语义: off 在档位表首位', () => {
  assert.equal(EFFORT_LEVELS[0], OFF_LEVEL)
})
