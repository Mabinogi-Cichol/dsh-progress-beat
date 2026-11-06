/**
 * 配置表单可写性测试 —— 复现并固定「面板保存被宿主拒绝」的那条判定链。
 *
 * 宿主 @deepseek-ai/dsh-settings 的 `describe()` / `write()` 只投影
 * **volatile** 字段：
 *
 *   - `volatileForm(schema)`：根或字段没有 `meta.volatile` 时返回 undefined；
 *   - `describe()`：`volatileForm` 为 undefined 的条目直接不进命名空间列表，
 *     于是浏览器侧 `configForms.get(entryId)` 拿到的快照没有 revision、
 *     status 停在 unavailable；
 *   - `write()`：`volatileForm` 为 undefined 时抛
 *     `Plugin entry "<ns>" has no volatile fields`，wire 层映射成
 *     ok:false —— 面板只看到「宿主没有接受这次写入」。
 *
 * 所以「Config 每个字段都必须 `.volatile()`」是硬要求，不是风格问题。
 * 这里直接复刻宿主的三个判定函数（见下），对真实 Config 求值。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Config, apply } from '../lib/index.js'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------- 宿主判定复刻
//
// 与 dsh-settings/lib/index.js 的 volatileForm / plainSchema / isVolatilePath
// 保持一致（只保留判定所需部分；secret 与默认值改写与本插件无关）。

/** @param {any} schema 插件 Config schema */
function volatileForm(schema) {
  if (schema.meta.volatile) return schema
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
  }
  return undefined
}

/** @param {any} schema 插件 Config schema @param {string[]} path 字段路径 */
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

const FIELDS = [
  'injectPrompt',
  'promptText',
  'promptEvery',
  'sectionOrder',
  'nudgeOnUserTurn',
  'userTurnText',
  'nudgeEveryTurns',
  'nudgeOnToolCalls',
  'every',
  'silentSeconds',
  'minGapSeconds',
  'maxRemindersPerTurn',
  'dripSeconds',
  'nudgeText',
]

// ------------------------------------------------ 判定：宿主必须能投影出表单
{
  const form = volatileForm(Config)
  assert.notEqual(
    form,
    undefined,
    'Config 必须含 volatile 字段，否则宿主 describe() 不投影该命名空间、write() 直接拒绝',
  )
  for (const field of FIELDS) {
    assert.ok(
      isVolatilePath(Config, [field]),
      `Config.${field} 必须 .volatile()，否则该字段的写入会被宿主判为 not volatile`,
    )
  }
}

// ---------------------------------- 判定：解析后的 config 是 volatile 引用
{
  const isVolatile = (value) =>
    typeof value === 'object' && value !== null && Object.getOwnPropertySymbols(value).length > 0 && typeof value.get === 'function'

  const parsed = Config({ every: 6, nudgeOnToolCalls: true })
  assert.ok(isVolatile(parsed.every), '解析后的 every 应是 volatile 引用（fiber.config 里的形态）')
  assert.equal(parsed.every.get(), 6)
}

// ------------------------------- 判定：宿主源码里仍是这套拒绝语义（防上游漂移）
{
  const path = require.resolve('@deepseek-ai/dsh-settings')
  const source = await readFile(path, 'utf8')
  assert.ok(
    source.includes('has no volatile fields'),
    '宿主 dsh-settings 的 write() 仍以 volatileForm 为前置条件',
  )
  assert.ok(source.includes('function volatileForm('), '宿主仍用 volatileForm 过滤表单字段')
}

// -------------------------------------- 活：volatile 更新后插件按新值重建挂载
{
  const { createVolatile, updateVolatile } = await import('@deepseek-ai/cosmokit')

  const sections = []
  const handlers = {}
  const effects = []
  const ctx = {
    systemPrompt: {
      section(spec) {
        const record = { ...spec, disposed: false }
        sections.push(record)
        return () => {
          record.disposed = true
        }
      },
    },
    on(event, handler) {
      const record = { handler, disposed: false }
      ;(handlers[event] ??= []).push(record)
      return () => {
        record.disposed = true
      }
    },
    effect(callback) {
      effects.push(callback())
      return () => {}
    },
    logger: { warn() {}, error() {} },
  }

  const config = Config({
    promptEvery: 4,
    injectPrompt: true,
    nudgeOnToolCalls: false,
    nudgeOnUserTurn: false,
    promptText: '规则：每 {{every}} 次说明一次。',
  })

  apply(ctx, config)

  const live = () => sections.filter((section) => !section.disposed).map((section) => section.text)
  assert.deepEqual(live(), ['规则：每 4 次说明一次。'], '首次 apply 按配置注册 section')
  assert.equal(handlers['agent/pre-step'], undefined, '未开启时不该挂 pre-step 钩子')

  // 模拟 Loader._commitVolatile：ref 换值 + loader/volatile-update 事件。
  updateVolatile(config.promptEvery, createVolatile(9))
  updateVolatile(config.nudgeOnToolCalls, createVolatile(true))
  updateVolatile(config.injectPrompt, createVolatile(false))

  const volatileListener = handlers['loader/volatile-update']?.[0]
  assert.ok(volatileListener, '必须监听 loader/volatile-update，否则配置改了不重跑 apply、改动不生效')
  volatileListener.handler([])

  assert.deepEqual(live(), [], '关掉 injectPrompt 后常驻规则应撤下')
  assert.ok(
    handlers['agent/pre-step']?.some((record) => !record.disposed),
    '打开 nudgeOnToolCalls 后应挂上 pre-step 钩子（沉默提醒在 pre-step 里判定）',
  )

  // 再打开常驻规则：文本用新的 every 渲染。
  updateVolatile(config.injectPrompt, createVolatile(true))
  volatileListener.handler([])
  assert.deepEqual(live(), ['规则：每 9 次说明一次。'], 'promptEvery 改动后 section 文本应跟着变')
}

console.log('OK: config form 可写性 + volatile 热更新通过')
