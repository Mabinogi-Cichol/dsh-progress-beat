/**
 * 沉默提醒的场景回归测试。
 *
 * 前面几个测试钉的是「单条规则」，这里钉的是**组合行为**：不同「工具调用速度 ×
 * 播报习惯」下，提醒到底落在第几次调用、总共几条。这两件事只有端到端跑一遍
 * 才看得出来（例如 fast burst 时 60 秒最小间隔会盖过 `every`，慢调用时
 * 时间阈值又会反过来先到）。
 *
 * 时钟走 `ctx.get('time')` 注入，所以整套剧本是确定性的，不需要 sleep。
 */

import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const DEFAULT = { every: 8, silentSeconds: 180, minGapSeconds: 60, maxRemindersPerTurn: 6, dripSeconds: 300 }

/**
 * 跑一个剧本：每步一次工具调用；模型每 `narrationEvery` 次调用播报一句
 * （`Infinity` 表示全程不播报）。可以跑多个用户轮。
 * @param options - 配置、调用耗时、总调用数、播报周期、轮数。
 * @returns 每次提醒的 `{ atCall, atSeconds, text }` 与断言所需的最小配置。
 */
async function runScenario({
  config = {},
  callSeconds = 2,
  calls = 200,
  narrationEvery = 25,
  turns = 1,
} = {}) {
  let now = 0
  const fired = []
  const handlers = {}
  const ctx = {
    systemPrompt: { section: () => () => {} },
    on: (event, handler) => ((handlers[event] ??= []).push(handler), () => {}),
    effect: (fn) => (fn(), () => {}),
    logger: { error() {}, warn() {} },
    get: (key) => (key === 'time' ? { now: () => now } : undefined),
  }
  apply(ctx, { nudgeOnToolCalls: true, ...DEFAULT, ...config })
  const pre = handlers['agent/pre-step'][0]

  const perTurn = Math.ceil(calls / turns)
  for (let turn = 1; turn <= turns; turn += 1) {
    const agent = { id: `sim-${turn}` }
    let messages = [{ id: `u${turn}`, role: 'user', source: { kind: 'user' } }]
    let said = 0

    const drive = async (step, atCall) => {
      const decision = await pre({ agent, messages, turn, step }, async () => ({ kind: 'enter', messages: [] }))
      const notice = (decision.messages ?? []).find((message) => message?.source?.kind === 'progress-beat')
      if (notice) fired.push({ turn, atCall, atSeconds: now / 1000, text: notice.content[0].text })
      return Boolean(notice)
    }

    await drive(0, 0)
    for (let index = 1; index <= perTurn; index += 1) {
      now += callSeconds * 1000
      messages = [
        ...messages,
        { id: `c${turn}-${index}`, role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh' }] },
        { id: `t${turn}-${index}`, role: 'tool', content: [] },
      ]
      if (index % narrationEvery === 0) {
        said += 1
        messages = [
          ...messages,
          { id: `said${turn}-${said}`, role: 'assistant', content: [{ type: 'text', text: '进度：这一批做完了。' }] },
        ]
      }
      await drive(index, index)
    }
  }

  return { fired, config: { ...DEFAULT, ...config }, callSeconds }
}

/** 每条提醒之间的间隔必须不小于 minGapSeconds（同一轮内）。 */
function assertMinGap({ fired, config }) {
  for (let index = 1; index < fired.length; index += 1) {
    const previous = fired[index - 1]
    const current = fired[index]
    if (previous.turn !== current.turn) continue
    const gapMs = (current.atSeconds - previous.atSeconds) * 1000
    assert.ok(
      gapMs >= config.minGapSeconds * 1000 || current.atCall > previous.atCall,
      `第 ${index} 条提醒间隔 ${gapMs / 1000}s 小于 minGapSeconds=${config.minGapSeconds}s`,
    )
  }
}

/** 同一轮内提醒条数不超过预算（滴灌除外，滴灌受 dripSeconds 约束）。 */
function assertBudget({ fired, config }) {
  const perTurn = new Map()
  for (const hit of fired) perTurn.set(hit.turn, (perTurn.get(hit.turn) ?? 0) + 1)
  for (const [turn, count] of perTurn) {
    assert.ok(
      count <= config.maxRemindersPerTurn,
      `第 ${turn} 轮触发了 ${count} 条，超过预算 ${config.maxRemindersPerTurn}`,
    )
  }
}

const callsOf = (result) => result.fired.map((hit) => hit.atCall)

// ---------------------------------------------------------------- 场景表
const SCENARIOS = []

{
  // 快调用（2 秒/次）+ 每 25 次播报：一个播报周期只提醒一次，条数由预算封顶。
  const result = await runScenario()
  SCENARIOS.push({ name: 'fast·每 25 次播报', result, expectedCalls: [8, 33, 58, 83, 108, 133] })
}

{
  // 快调用 + 全程不播报：最小间隔（60 秒 = 30 次调用）接管节奏。
  const result = await runScenario({ narrationEvery: Infinity })
  SCENARIOS.push({ name: 'fast·全程沉默', result, expectedCalls: [8, 38, 68, 98, 128, 158] })
}

{
  // 慢调用（30 秒/次）：每 8 次调用要 240 秒，早就过了 180 秒的时间阈值，
  // 所以节奏改由 silentSeconds 决定（第 6 次调用 = 180 秒）。
  const result = await runScenario({ callSeconds: 30, calls: 40, narrationEvery: Infinity })
  SCENARIOS.push({ name: 'slow·全程沉默', result, expectedCalls: [6, 12, 18, 24, 30, 36] })
}

{
  // 安静档：阈值更大、预算更小。
  const result = await runScenario({
    config: { every: 12, silentSeconds: 240, minGapSeconds: 90, maxRemindersPerTurn: 4, dripSeconds: 600 },
  })
  SCENARIOS.push({ name: 'fast·安静档', result, expectedCalls: [12, 37, 62, 87] })
}

{
  // 每轮预算各自独立：两轮各 200 次调用，每轮都该把 6 条预算用完，
  // 第二轮不能因为第一轮打满而提前进入滴灌。
  const result = await runScenario({ calls: 400, turns: 2, narrationEvery: Infinity })
  SCENARIOS.push({
    name: '两轮·预算独立',
    result,
    expectedCalls: [8, 38, 68, 98, 128, 158, 8, 38, 68, 98, 128, 158],
    expectedTurns: [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2],
  })
}

// ---------------------------------------------------------------- 断言
for (const scenario of SCENARIOS) {
  const { result, expectedCalls, expectedTurns } = scenario
  assert.deepEqual(
    callsOf(result),
    expectedCalls,
    `${scenario.name}：提醒位置应为 ${expectedCalls.join(',')}，实际 ${callsOf(result).join(',')}`,
  )
  if (expectedTurns !== undefined) {
    assert.deepEqual(result.fired.map((hit) => hit.turn), expectedTurns, `${scenario.name}：轮次归属`)
  }
  assertMinGap(result)
  assertBudget(result)
  for (const hit of result.fired) {
    assert.ok(hit.text.includes('次工具调用'), `${scenario.name}：文案要带上累计调用数`)
    assert.ok(/第 \d+ 次提醒/.test(hit.text), `${scenario.name}：文案要带上本轮第几次提醒`)
  }
  console.log(
    `  ${scenario.name.padEnd(18)} ${result.fired.length} 条 @ ${callsOf(result).join(', ')}`,
  )
}

// ------------------------------------------- 关键性质的逐条断言（防退化）
{
  // 播报即归零：播报之后攒到 every-1 次不提醒，第 every 次立刻提醒。
  const { fired } = await runScenario({ calls: 12, narrationEvery: 99, config: { every: 5, minGapSeconds: 10 } })
  assert.deepEqual(callsOf({ fired }), [5, 10], '播报缺失时应按 5 次节奏提醒')

  // 时间阈值优先：调用数远未达标，但沉默时间到了。
  const slow = await runScenario({
    callSeconds: 100,
    calls: 3,
    narrationEvery: Infinity,
    config: { every: 50, silentSeconds: 60, minGapSeconds: 10 },
  })
  assert.deepEqual(callsOf(slow), [1, 2, 3], '每次调用都隔了 100 秒，远超时间阈值与最小间隔')

  // 预算为 0：一次都不提醒。
  const off = await runScenario({ calls: 100, narrationEvery: Infinity, config: { maxRemindersPerTurn: 0 } })
  assert.equal(off.fired.length, 0, '预算 0 表示关掉这一路')

  // 没有任何工具调用时不会被时间阈值误触。
  const idle = await runScenario({ calls: 0, narrationEvery: Infinity, config: { silentSeconds: 30 } })
  assert.equal(idle.fired.length, 0, '没有工具调用就不该提醒')
}

console.log('OK: 沉默提醒场景回归通过')
