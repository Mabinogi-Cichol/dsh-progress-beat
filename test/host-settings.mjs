/**
 * 宿主集成测试：直接跑 @deepseek-ai/dsh-settings 的真实 SettingsForms，
 * 对真实 Config 走一遍 `describe()` → `mutate()`。
 *
 * 为什么需要它：面板保存失败的那条链路横跨插件与宿主两半，
 *   client.mutate → settingsController.mutate → SettingsForms.write
 *     → volatileForm(schema) / isVolatilePath()
 * 只测插件侧永远看不到「字段不是 volatile」这件事。这里用一个最小的
 * configEditor / profileContext 桩把真实宿主代码拉起来，于是：
 *
 *   - 正例：本插件的命名空间出现在 describe() 里，set/unset 真的写进文档；
 *   - 反例：同样的写入打到一份没有 volatile 的 schema 上，宿主抛
 *     `has no volatile fields` —— 这正是面板之前看到的「没有接受这次写入」。
 */

import assert from 'node:assert/strict'
import SettingsForms, { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Config } from '../lib/index.js'

/** 与宿主 dsh-settings 的 mergeLayers 同义：对象递归合并，其余整体替换。 */
function mergeLayers(under, over) {
  const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isPlain(under) || !isPlain(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value
  }
  return merged
}

/**
 * 拉一个最小宿主：configEditor 只认一条插件行，profileContext 指向一个不存在的
 * home（于是宿主的 settings.yaml 迁移逻辑直接空转）。
 * @param id - Loader 行 id，也是 settings 命名空间。
 * @param schema - 该行的 Config schema。
 * @param base - 继承层（bundle patch 里的默认配置）。
 */
function makeHost(id, schema, base) {
  let user = {}
  const entry = {
    id,
    options: { id, config: mergeLayers(base, user) },
    fiber: { uid: 1, state: 2, runtime: { Config: schema }, ctx: {}, config: schema(mergeLayers(base, user)) },
  }

  const configEditor = {
    documentPath: 'MEMORY',
    entries: () => [entry],
    configuration: () => [{ entry, inherited: base, override: user }],
    async edit(target, change) {
      user = change(user, base)
      target.options.config = mergeLayers(base, user)
      target.fiber.config = schema(target.options.config)
    },
  }

  const ctx = new Context()
  for (const [name, value] of Object.entries({
    profileContext: { home: 'C:/Windows/Temp/dsh-progress-beat-nonexistent-profile' },
    configEditor,
    loader: { await: async () => {} },
  })) {
    ctx.provide(name)
    ctx.set(name, value)
  }

  const settings = new SettingsForms(ctx)
  return { settings, user: () => user, ctx }
}

const BASE = { every: 4, maxRemindersPerTurn: 12, injectPrompt: true }
const NS = 'dsh-progress-beat'

// ---------------------------------------------------- 正例：本插件的真实 schema
{
  const { settings, user } = makeHost(NS, Config, BASE)

  const rows = settings.describe()
  const row = rows.find((candidate) => candidate.ns === NS)
  assert.ok(row, 'discover: 命名空间必须出现在 describe() 里，否则浏览器侧表单只读')
  assert.equal(row.value.every, 4, 'value 是继承值与用户覆盖的合成结果')
  assert.equal(row.base.every, 4, 'base 是继承层')
  assert.deepEqual(row.user, {}, '尚未写入时用户层为空')
  assert.equal(typeof row.revision, 'number', '快照必须带 revision，写入要拿它做栅栏')
  assert.ok(Array.isArray(row.schema?.dict ? Object.keys(row.schema.dict) : []), '投影出的表单 schema 含字段')

  // set：面板保存时发的那一条 op。
  await settings.mutate(NS, [{ op: 'set', path: ['every'], value: 9 }], row.revision)
  assert.equal(user().every, 9, '写入进入用户层')
  assert.equal(settings.describe().find((r) => r.ns === NS).value.every, 9, '写入后立即生效')

  // 布尔开关。
  await settings.mutate(NS, [{ op: 'set', path: ['injectPrompt'], value: false }])
  assert.equal(settings.describe().find((r) => r.ns === NS).value.injectPrompt, false)

  // 三个机制各自的节奏字段都必须可写：漏一个 volatile 就会在面板上写不动。
  await settings.mutate(NS, [
    { op: 'set', path: ['promptEvery'], value: 9 },
    { op: 'set', path: ['sectionOrder'], value: 7 },
    { op: 'set', path: ['nudgeEveryTurns'], value: 3 },
    { op: 'set', path: ['silentSeconds'], value: 240 },
    { op: 'set', path: ['minGapSeconds'], value: 45 },
    { op: 'set', path: ['dripSeconds'], value: 600 },
  ])
  const cadence = settings.describe().find((r) => r.ns === NS).value
  assert.equal(cadence.promptEvery, 9, '常驻规则步频可写')
  assert.equal(cadence.sectionOrder, 7, 'section 插入位置可写')
  assert.equal(cadence.nudgeEveryTurns, 3, '用户轮节奏可写')
  assert.equal(cadence.silentSeconds, 240, '沉默时间阈值可写')
  assert.equal(cadence.minGapSeconds, 45, '最小提醒间隔可写')
  assert.equal(cadence.dripSeconds, 600, '预算用尽后的滴灌间隔可写')

  // 多字段原子写入（面板一次保存多条 op）。
  await settings.mutate(NS, [
    { op: 'set', path: ['nudgeOnToolCalls'], value: true },
    { op: 'set', path: ['nudgeText'], value: '自定义兜底文本' },
  ])
  const afterBatch = settings.describe().find((r) => r.ns === NS)
  assert.equal(afterBatch.value.nudgeOnToolCalls, true)
  assert.equal(afterBatch.value.nudgeText, '自定义兜底文本')

  // unset：清掉用户覆盖，回到继承层。
  await settings.mutate(NS, [{ op: 'unset', path: ['every'] }])
  assert.equal(settings.describe().find((r) => r.ns === NS).value.every, 4, 'unset 后回落到继承值')

  // 栅栏：拿旧 revision 写会被拒，客户端应重读而不是硬写。
  const stale = settings.describe().find((r) => r.ns === NS).revision
  await settings.mutate(NS, [{ op: 'set', path: ['every'], value: 6 }])
  await assert.rejects(
    () => settings.mutate(NS, [{ op: 'set', path: ['every'], value: 7 }], stale),
    (error) => error instanceof SettingsConflictError && error.code === 'SETTINGS_CONFLICT',
    '过期 revision 必须被拒',
  )
}

// ---------------------------------- 反例：没有 volatile 的 schema 就是老症状
{
  const Plain = Schema.object({
    every: Schema.number().default(4),
    injectPrompt: Schema.boolean().default(true),
  })
  const { settings } = makeHost('plain-entry', Plain, { every: 4, injectPrompt: true })

  assert.equal(
    settings.describe().length,
    0,
    '没有 volatile 字段的条目不会出现在 describe() 里 —— 浏览器侧因此拿不到表单',
  )
  await assert.rejects(
    () => settings.mutate('plain-entry', [{ op: 'set', path: ['every'], value: 9 }]),
    /has no volatile fields/,
    '没有 volatile 字段的写入会被宿主拒绝 —— 面板看到的就是这一条',
  )
}

console.log('OK: 宿主 dsh-settings 接受本插件配置写入')
