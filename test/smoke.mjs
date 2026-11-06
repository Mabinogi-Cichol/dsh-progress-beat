import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

/** 一份最小的宿主上下文：记录 system prompt section 与事件处理器。 */
function makeCtx() {
  const sections = []
  const handlers = {}
  const ctx = {
    systemPrompt: { section: (spec) => (sections.push(spec), () => {}) },
    on: (event, handler) => ((handlers[event] ??= []).push(handler), () => {}),
    logger: { error: (m) => console.error('[logger.error]', m) },
  }
  return { ctx, sections, handlers }
}

/** pre-step 的下游决定：进入 step，消息里已有一条用户消息。 */
const enterNext = async () => ({
  kind: 'enter',
  messages: [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
  startsRequestSeries: true,
})
/** tools/post-execute 的下游结果。 */
const acceptNext = async () => ({ kind: 'accept' })

// ---------------------------------------------------------------- 默认行为
{
  const { ctx, sections, handlers } = makeCtx()
  apply(ctx, {})

  assert.equal(name, 'progress-beat')
  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-progress-beat/progress')
  assert.equal(sections[0].order, 4)
  assert.ok(!sections[0].text.includes('{{every}}'), 'placeholder must be filled')

  // 默认不挂工具调用钩子：工具链阶段零上下文。
  assert.equal(handlers['tools/post-execute'], undefined, 'tool-call nudge must be off by default')

  const pre = handlers['agent/pre-step'][0]
  assert.equal(typeof pre, 'function', 'user-turn nudge must be registered by default')

  const agent = { id: 'agent-a' }
  const payload = { agent, messages: [{ source: { kind: 'user' } }], turn: 1, step: 0 }

  const first = await pre(payload, enterNext)
  assert.equal(first.kind, 'enter')
  assert.equal(first.startsRequestSeries, true, 'other decision fields must survive')
  assert.equal(first.messages.length, 2, 'one notice appended to the user turn')
  const notice = first.messages[1]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'progress-beat')
  assert.equal(notice.source.form, 'notice')
  assert.ok(notice.source.summary.length <= 120)
  assert.ok(Object.isFrozen(notice) && Object.isFrozen(notice.content), 'notice must be frozen')
  assert.ok(notice.content[0].text.includes('本轮开始'))

  // 同一 turn 的后续 step 不再注入。
  const laterStep = await pre({ ...payload, step: 1 }, enterNext)
  assert.equal(laterStep.messages.length, 1, 'a turn carries the notice only once')

  // 新 turn 再注入一次。
  const nextTurn = await pre({ ...payload, turn: 2, step: 0 }, enterNext)
  assert.equal(nextTurn.messages.length, 2, 'each new turn gets its own notice')

  // reject 决定原样透传，不追加消息。
  const rejected = await pre({ ...payload, turn: 3, step: 0 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
}

// ------------------------------------------------- 工具调用注入（显式开启）
{
  const { ctx, handlers } = makeCtx()
  apply(ctx, { nudgeOnToolCalls: true, nudgeOnUserTurn: false, every: 3, maxRemindersPerTurn: 2 })

  const post = handlers['tools/post-execute'][0]
  assert.equal(typeof post, 'function', 'tool-call nudge must be registered when enabled')

  const agent = { id: 'agent-b' }
  const sizes = []
  for (let i = 1; i <= 6; i += 1) {
    const decision = await post({ name: 'pwsh', arguments: {}, agent }, null, acceptNext)
    sizes.push(decision.additionalContexts?.length ?? 0)
    if (decision.additionalContexts) {
      const nudge = decision.additionalContexts[0]
      assert.equal(nudge.role, 'user')
      assert.equal(nudge.source.kind, 'progress-beat')
      assert.equal(nudge.source.form, 'notice')
      assert.ok(nudge.content[0].text.includes(`${i} 次工具调用`))
      assert.ok(Object.isFrozen(nudge) && Object.isFrozen(nudge.content))
    }
  }
  console.log('steps:', sizes.join(','))
  assert.deepEqual(sizes, [0, 0, 1, 0, 0, 1], 'reminder cadence must follow `every`')

  // 配额上限。
  const { ctx: ctxCap, handlers: capHandlers } = makeCtx()
  apply(ctxCap, { nudgeOnToolCalls: true, nudgeOnUserTurn: false, every: 2, maxRemindersPerTurn: 1 })
  const capAgent = { id: 'agent-c' }
  const capSizes = []
  for (let i = 0; i < 4; i += 1) {
    const d = await capHandlers['tools/post-execute'][0]({ name: 'pwsh', arguments: {}, agent: capAgent }, null, acceptNext)
    capSizes.push(d.additionalContexts?.length ?? 0)
  }
  assert.deepEqual(capSizes, [0, 1, 0, 0], 'cap of 1 reminder must be respected')

  // block 分支保留 feedback 与下游上下文。
  const blockNext = async () => ({ kind: 'block', feedback: 'denied', additionalContexts: [{ marker: 'downstream' }] })
  const stateAgent = { id: 'agent-e' }
  for (let i = 0; i < 2; i += 1) await post({ name: 'x', arguments: {}, agent: stateAgent }, null, acceptNext)
  const blockedAtBeat = await post({ name: 'x', arguments: {}, agent: stateAgent }, null, blockNext)
  assert.equal(blockedAtBeat.kind, 'block')
  assert.equal(blockedAtBeat.feedback, 'denied')
  assert.equal(blockedAtBeat.additionalContexts.length, 2)
  assert.equal(blockedAtBeat.additionalContexts[1].marker, 'downstream')

  // 无 agent 的直接调用不计数、不注入。
  const direct = await post({ name: 'x', arguments: {} }, null, acceptNext)
  assert.equal(direct.additionalContexts, undefined)

  // 新用户提示词清空计数与配额。
  const pre = handlers['agent/pre-step'][0]
  const resetAgent = { id: 'agent-f' }
  await post({ name: 'x', arguments: {}, agent: resetAgent }, null, acceptNext)
  await pre({ agent: resetAgent, messages: [{ source: { kind: 'user' } }], turn: 1, step: 0 }, enterNext)
  const afterReset = await post({ name: 'x', arguments: {}, agent: resetAgent }, null, acceptNext)
  assert.equal(afterReset.additionalContexts, undefined, 'counter must reset on a new user turn')
}

// ------------------------------------------------------------ 两路都关掉
{
  const { ctx, handlers } = makeCtx()
  apply(ctx, { nudgeOnUserTurn: false, nudgeOnToolCalls: false })
  assert.equal(handlers['tools/post-execute'], undefined)
  const pre = handlers['agent/pre-step'][0]
  const decision = await pre(
    { agent: { id: 'agent-g' }, messages: [{ source: { kind: 'user' } }], turn: 1, step: 0 },
    enterNext,
  )
  assert.equal(decision.messages.length, 1, 'no context at all when both paths are off')
}

// ------------------------------------------------------- 自定义文本与占位符
{
  const { ctx, handlers } = makeCtx()
  apply(ctx, { userTurnText: '自定义提醒：每 {{every}} 次调用讲一次。', every: 7 })
  const pre = handlers['agent/pre-step'][0]
  const decision = await pre(
    { agent: { id: 'agent-h' }, messages: [{ source: { kind: 'user' } }], turn: 1, step: 0 },
    enterNext,
  )
  assert.equal(decision.messages[1].content[0].text, '自定义提醒：每 7 次调用讲一次。')
}

// ------------------------------------------------------------ 关闭 prompt
{
  const { ctx } = makeCtx()
  ctx.systemPrompt = { section: () => assert.fail('should not register') }
  apply(ctx, { injectPrompt: false })
}

console.log('OK: all progress-beat checks passed')