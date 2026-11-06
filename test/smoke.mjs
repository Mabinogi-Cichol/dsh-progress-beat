import assert from 'node:assert/strict'
import { apply, name, inject, Config } from '../lib/index.js'

/** 会话消息构造器：只保留插件判定要用的形状。 */
const user = (id = 'u1') => ({ id, role: 'user', source: { kind: 'user' } })
const tool = (id) => ({ id, role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'ok' }] })
const said = (id, text = '进度：正在读取配置。') => ({ id, role: 'assistant', content: [{ type: 'text', text }] })
const called = (id) => ({ id, role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh' }] })

/** 一份最小的宿主上下文：记录 system prompt section 与事件处理器，可注入假时钟。 */
function makeCtx({ now } = {}) {
  const sections = []
  const handlers = {}
  const clock = { value: now ?? 1_000_000 }
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
    on: (event, handler) => ((handlers[event] ??= []).push(handler), () => {}),
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { error: (m) => console.error('[logger.error]', m), warn: () => {} },
  }
  if (now !== undefined) ctx.get = (key) => (key === 'time' ? { now: () => clock.value } : undefined)
  return { ctx, sections, handlers, clock }
}

/** pre-step 的下游决定：进入 step。 */
const enterNext = async () => ({ kind: 'enter', messages: [], startsRequestSeries: true })

/** 驱动一次 pre-step，返回追加的 notice 数量。 */
async function step(handler, clock, { agent, messages, turn, step: stepIndex = 0, advance = 0 }) {
  clock.value += advance
  const decision = await handler({ agent, messages, turn, step: stepIndex }, enterNext)
  return decision
}

const notices = (decision) => (decision.messages ?? []).filter((message) => message?.source?.kind === 'progress-beat')

// --------------------------------------------------- 默认：只有一个 section
{
  const { ctx, sections, handlers } = makeCtx()
  apply(ctx, {})

  assert.equal(name, 'progress-beat')
  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-progress-beat/progress')
  assert.equal(sections[0].order, 4)
  assert.ok(!sections[0].text.includes('{{every}}'), 'placeholder must be filled')

  // 沉默提醒默认开启：pre-step 钩子必须挂上（用户轮提醒仍默认关）。
  assert.equal(handlers['agent/pre-step']?.length, 1, '沉默提醒默认开启，pre-step 钩子应注册')
  assert.equal(handlers['tools/post-execute'], undefined, 'the plugin no longer hooks post-execute')

  // 默认配置下，一个没有工具调用的空轮不该产出任何注入。
  const pre = handlers['agent/pre-step'][0]
  const quiet = await pre({ agent: { id: 'default-agent' }, messages: [user('u')], turn: 1, step: 0 }, enterNext)
  assert.equal(notices(quiet).length, 0, '默认不该在轮次入口注入（用户轮提醒默认关）')
}

// -------------------------------------- 用户轮提醒：每轮 / 每 N 轮
{
  const { ctx, handlers } = makeCtx()
  apply(ctx, { nudgeOnUserTurn: true, nudgeEveryTurns: 3 })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-turn' }
  const hits = []
  for (let turn = 1; turn <= 8; turn += 1) {
    const decision = await pre({ agent, messages: [user('u')], turn, step: 0 }, enterNext)
    hits.push(notices(decision).length === 1)
  }
  assert.deepEqual(hits, [true, false, false, true, false, false, true, false], '每 3 轮提醒一次')

  const { ctx: ctxEvery, handlers: everyHandlers, clock } = makeCtx()
  apply(ctxEvery, { nudgeOnUserTurn: true })
  const everyPre = everyHandlers['agent/pre-step'][0]
  for (let turn = 1; turn <= 3; turn += 1) {
    const decision = await step(everyPre, clock, { agent: { id: 'a2' }, messages: [user('u')], turn })
    assert.equal(notices(decision).length, 1, `第 ${turn} 轮应提醒`)
  }
}

// ------------------------------ 沉默提醒 A：模型播报过就不提醒（沉默计数归零）
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, { nudgeOnToolCalls: true, every: 3, maxRemindersPerTurn: 10, minGapSeconds: 0 })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-a' }

  // 第 0 步：本轮开始，只有用户消息。
  let d = await step(pre, clock, { agent, messages: [user('u')], turn: 1 })
  assert.equal(notices(d).length, 0)

  // 2 次调用：未到阈值。
  d = await step(pre, clock, { agent, messages: [user('u'), called('c1'), tool('t1'), called('c2'), tool('t2')], turn: 1, step: 1 })
  assert.equal(notices(d).length, 0, '未到沉默阈值')

  // 第 3 次调用：触发。
  d = await step(pre, clock, {
    agent,
    messages: [user('u'), called('c1'), tool('t1'), called('c2'), tool('t2'), called('c3'), tool('t3')],
    turn: 1,
    step: 2,
  })
  assert.equal(notices(d).length, 1, '累计 3 次未播报应提醒')
  assert.ok(notices(d)[0].content[0].text.includes('3 次工具调用'))

  // 模型说了一句：沉默计数从这句话重新算，所以后面只攒 2 次调用不该提醒。
  const afterSaid = [
    user('u'),
    called('c1'), tool('t1'), called('c2'), tool('t2'), called('c3'), tool('t3'),
    said('a1'),
    called('c4'), tool('t4'), called('c5'), tool('t5'),
  ]
  d = await step(pre, clock, { agent, messages: afterSaid, turn: 1, step: 3 })
  assert.equal(notices(d).length, 0, '播报之后再攒 2 次调用（< every=3）不该提醒')

  // 第 3 次：按「自播报以来」计数，而不是本轮总调用数。
  d = await step(pre, clock, {
    agent,
    messages: [...afterSaid, called('c6'), tool('t6')],
    turn: 1,
    step: 4,
  })
  assert.equal(notices(d).length, 1, '播报之后又沉默 3 次调用应再次提醒')
  assert.ok(
    notices(d)[0].content[0].text.includes('3 次工具调用'),
    '计数基准是「自上次播报」，不是本轮总调用数（此刻本轮已有 6 次）',
  )
}

// --------------------------------------- 沉默提醒 B：时间阈值也能单独触发
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, { nudgeOnToolCalls: true, every: 100, silentSeconds: 60, minGapSeconds: 0, maxRemindersPerTurn: 10 })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-b' }

  await step(pre, clock, { agent, messages: [user('u')], turn: 1 })
  const messages = [user('u'), called('c1'), tool('t1')]

  let d = await step(pre, clock, { agent, messages, turn: 1, step: 1, advance: 30_000 })
  assert.equal(notices(d).length, 0, '30 秒还不够')

  d = await step(pre, clock, { agent, messages, turn: 1, step: 2, advance: 31_000 })
  assert.equal(notices(d).length, 1, '超过 60 秒没有播报应提醒')
  assert.ok(notices(d)[0].content[0].text.includes('秒没有向用户说明进展'))
}

// ------------------------------------------------ 最小间隔：挡住连续步骤刷屏
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, { nudgeOnToolCalls: true, every: 2, minGapSeconds: 60, maxRemindersPerTurn: 10 })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-gap' }
  // 会话是追加的：每次再走两步就多两次工具调用，沉默计数才继续增长。
  const trace = [user('u')]
  const push = (index) => trace.push(called(`c${index}`), tool(`t${index}`))

  await step(pre, clock, { agent, messages: [...trace], turn: 1 })
  push(1)
  push(2)
  let d = await step(pre, clock, { agent, messages: [...trace], turn: 1, step: 1, advance: 5_000 })
  assert.equal(notices(d).length, 1, '首次达标即提醒')

  push(3)
  push(4)
  d = await step(pre, clock, { agent, messages: [...trace], turn: 1, step: 2, advance: 30_000 })
  assert.equal(notices(d).length, 0, '间隔不足 60 秒不再提醒')

  push(5)
  push(6)
  d = await step(pre, clock, { agent, messages: [...trace], turn: 1, step: 3, advance: 31_000 })
  assert.equal(notices(d).length, 1, '够了最小间隔就再提醒')
}

// ------------------------------- 预算 + 滴灌：打满预算后不静音，只是变稀疏
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, {
    nudgeOnToolCalls: true,
    every: 2,
    minGapSeconds: 10,
    maxRemindersPerTurn: 1,
    dripSeconds: 300,
  })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-drip' }
  const trace = [user('u')]
  const push = (index) => trace.push(called(`c${index}`), tool(`t${index}`))

  await step(pre, clock, { agent, messages: [...trace], turn: 1 })
  push(1)
  push(2)
  let d = await step(pre, clock, { agent, messages: [...trace], turn: 1, step: 1, advance: 5_000 })
  assert.equal(notices(d).length, 1, '预算内正常提醒')

  push(3)
  push(4)
  d = await step(pre, clock, { agent, messages: [...trace], turn: 1, step: 2, advance: 60_000 })
  assert.equal(notices(d).length, 0, '预算用尽且未到滴灌间隔')

  push(5)
  push(6)
  d = await step(pre, clock, { agent, messages: [...trace], turn: 1, step: 3, advance: 250_000 })
  assert.equal(notices(d).length, 1, '预算用尽后按滴灌间隔继续，而不是永久静音')
}

// --------------------------------------------- 预算为 0：这一路彻底关掉
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, { nudgeOnToolCalls: true, every: 2, maxRemindersPerTurn: 0 })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-off' }
  const many = [user('u'), called('c1'), tool('t1'), called('c2'), tool('t2')]
  await step(pre, clock, { agent, messages: [user('u')], turn: 1 })
  const d = await step(pre, clock, { agent, messages: many, turn: 1, step: 1, advance: 3_600_000 })
  assert.equal(notices(d).length, 0, 'maxRemindersPerTurn=0 时完全不提醒')
}

// ------------------------------------- 无 agent / 拒绝决定：不注入、不计数
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, { nudgeOnToolCalls: true, every: 2, minGapSeconds: 0 })
  const pre = handlers['agent/pre-step'][0]
  const many = [user('u'), called('c1'), tool('t1'), called('c2'), tool('t2')]

  const noAgent = await pre({ messages: many, turn: 1, step: 0 }, enterNext)
  assert.equal(notices(noAgent).length, 0, '没有 agent 就不注入')

  const rejected = await pre({ agent: { id: 'x' }, messages: many, turn: 1, step: 0 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' }, 'reject 决定原样透传')
}

// ------------------------------------------------------- 自定义文本与占位符
{
  const { ctx, handlers, clock } = makeCtx({ now: 0 })
  apply(ctx, {
    nudgeOnToolCalls: true,
    every: 2,
    minGapSeconds: 0,
    promptEvery: 7,
    nudgeText: '已 {{count}} 次调用、{{seconds}} 秒没说话（第 {{remind}} 次）。',
  })
  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-text' }
  await step(pre, clock, { agent, messages: [user('u')], turn: 1 })
  const d = await step(pre, clock, {
    agent,
    messages: [user('u'), called('c1'), tool('t1'), called('c2'), tool('t2')],
    turn: 1,
    step: 1,
    advance: 5_000,
  })
  assert.equal(notices(d)[0].content[0].text, '已 2 次调用、5 秒没说话（第 1 次）。')
}

// ------------------------------- 常驻规则的位置与步频可以由配置驱动
{
  const { ctx, sections } = makeCtx()
  apply(ctx, { promptEvery: 9, sectionOrder: 7, promptText: '每 {{every}} 次说一句。' })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].order, 7, 'sectionOrder 必须写进 section.order')
  assert.equal(sections[0].text, '每 9 次说一句。', 'promptEvery 必须填进 {{every}}')
}

// ------------------------------------------------------------ 关闭 prompt
{
  const { ctx } = makeCtx()
  ctx.systemPrompt = { section: () => assert.fail('should not register') }
  apply(ctx, { injectPrompt: false })
}

// ------------------------------- 解析后的配置（volatile 引用）能正常接线
{
  const { ctx, sections, handlers } = makeCtx()
  apply(ctx, Config({ promptEvery: 6, nudgeOnUserTurn: true }))
  assert.equal(sections.length, 1, '默认仍注册常驻规则')
  assert.ok(sections[0].text.includes('6'), 'promptEvery 必须从 volatile 引用里解包出来')
  assert.equal(typeof handlers['agent/pre-step']?.[0], 'function', '布尔开关也要能从引用里读到')
}

console.log('OK: all progress-beat checks passed')
