import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

const sections = []
const handlers = {}
const ctx = {
  systemPrompt: { section: (spec) => (sections.push(spec), () => {}) },
  on: (event, handler) => ((handlers[event] ??= []).push(handler), () => {}),
  logger: { error: (m) => console.error('[logger.error]', m) },
}

apply(ctx, { every: 3, maxRemindersPerTurn: 2 })

assert.equal(name, 'progress-beat')
assert.deepEqual(inject, ['systemPrompt'])
assert.equal(sections.length, 1)
assert.equal(sections[0].name, 'dsh-progress-beat/progress')
assert.equal(sections[0].order, 4)
assert.ok(sections[0].text.includes('{{every}}') === false, 'placeholder must be filled')
assert.ok(sections[0].text.includes('3 次工具调用'), 'every must be interpolated')

const post = handlers['tools/post-execute'][0]
const pre = handlers['agent/pre-step'][0]
const next = async () => ({ kind: 'accept' })
const agent = {}

const sizes = []
for (let i = 1; i <= 6; i += 1) {
  const decision = await post({ name: 'pwsh', arguments: {}, agent }, null, next)
  sizes.push(decision.additionalContexts?.length ?? 0)
  if (decision.additionalContexts) {
    const notice = decision.additionalContexts[0]
    assert.equal(notice.role, 'user')
    assert.equal(notice.source.kind, 'progress-beat')
    assert.equal(notice.source.form, 'notice')
    assert.ok(notice.source.summary.length <= 120)
    assert.ok(notice.content[0].text.includes(`${i} 次工具调用`))
    assert.ok(Object.isFrozen(notice) && Object.isFrozen(notice.content))
  }
}
// every=3, cap=2 → 第 3、6 次各注入一次
console.log('steps:', sizes.join(','))
assert.deepEqual(sizes, [0, 0, 1, 0, 0, 1], 'reminder cadence must follow `every`')

// 配额上限：every=2 且 maxRemindersPerTurn=1 → 只有第 2 次注入
const h2 = {}
const ctx3 = {
  systemPrompt: { section: () => () => {} },
  on: (event, handler) => ((h2[event] ??= []).push(handler), () => {}),
  logger: { error: console.error },
}
apply(ctx3, { every: 2, maxRemindersPerTurn: 1 })
const capAgent = {}
const capSizes = []
for (let i = 0; i < 4; i += 1) {
  const d = await h2['tools/post-execute'][0]({ name: 'pwsh', arguments: {}, agent: capAgent }, null, next)
  capSizes.push(d.additionalContexts?.length ?? 0)
}
assert.deepEqual(capSizes, [0, 1, 0, 0], 'cap of 1 reminder must be respected')

// 新用户提示词 → 计数与配额清零
await pre({ agent, messages: [{ source: { kind: 'user' } }] }, next)
const afterReset = await post({ name: 'pwsh', arguments: {}, agent }, null, next)
assert.equal(afterReset.additionalContexts ?? undefined, undefined, 'counter must reset')
const again = [1, 2].map(() => post({ name: 'pwsh', arguments: {}, agent }, null, next))
const results = await Promise.all(again)
assert.equal(results[1].additionalContexts.length, 1, 'counter restarts from the new turn')

// block 分支保留 feedback 与下游上下文
const blockNext = async () => ({ kind: 'block', feedback: 'denied', additionalContexts: [{ marker: 'downstream' }] })
const stateAgent = {}
for (let i = 0; i < 2; i += 1) await post({ name: 'x', arguments: {}, agent: stateAgent }, null, next)
const blocked = await post({ name: 'x', arguments: {}, agent: stateAgent }, null, blockNext)
assert.equal(blocked.kind, 'block')
assert.equal(blocked.feedback, 'denied')
assert.equal(blocked.additionalContexts.length, 2)
assert.equal(blocked.additionalContexts[1].marker, 'downstream')

// 无 agent 的直接调用不计数、不注入
const direct = await post({ name: 'x', arguments: {} }, null, next)
assert.equal(direct.additionalContexts, undefined)

// 关闭 prompt 注入
const ctx2 = { ...ctx, systemPrompt: { section: () => assert.fail('should not register') }, on: () => {} }
apply(ctx2, { injectPrompt: false })

console.log('OK: all progress-beat checks passed')
