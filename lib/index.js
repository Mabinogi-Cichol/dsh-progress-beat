/**
 * dsh-progress-beat
 *
 * 目标：让 agent 在长时间「思考 + 工具调用」过程中持续输出用户可见的进度说明，
 * 而不是一路静默到任务结束才说话。
 *
 * 两条互补的机制：
 * 1. 请求侧（system prompt section）：常驻规则，要求模型进入新阶段 / 每若干次工具
 *    调用前先写 1–2 句中文进度说明。这条规则跟随每一次请求，无需额外轮次。
 * 2. 步骤侧（tools/post-execute）：按工具调用次数计数，每 N 次向本步骤注入一条
 *    notice 上下文，硬性提醒模型「先播报再继续」。模型自己不愿意说话时，这是
 *    兜底。注入的 notice 同时也会在会话里留下一条可见的合成消息。
 *
 * 唯一的包依赖是 `@deepseek-ai/schemastery`：Config 必须是可投影的 schema，
 * `ctx.settings` 才能为它生成表单，控制面板（client.js）也才有可写的数据面。
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'progress-beat'

/** 等待 host 的 systemPrompt 服务就绪后再 apply。 */
export const inject = ['systemPrompt']

/** 默认进度规则文本；`{{every}}` 会被替换为配置里的步频。 */
const DEFAULT_PROMPT_TEXT = `进度可见性（强制）：
1. 预计需要 2 次以上工具调用时，在第一次调用之前先用一句中文说明打算怎么做。
2. 每累计约 {{every}} 次工具调用，或完成一个阶段（信息收集 → 实现 → 验证 → 收尾），必须停下来说 1–2 句中文进度：现在在做什么、刚确认了什么结论、下一步做什么，然后再继续调用工具。
3. 进度说明是写给用户看的短句：不要复述工具输出，不要贴大段日志、命令或代码。
4. 进度说明不能替代最终答复；任务结束时仍要按用户要求给出完整结论。`

/** 注入提醒文本；同样支持 `{{every}}`。 */
const DEFAULT_NUDGE_TEXT = `进度播报提醒（系统）：你已经连续执行了 {{count}} 次工具调用，但还没有向用户说明进展。在继续调用任何工具之前，先用 1–2 句中文写出当前进度（在做什么 / 刚得到什么结论 / 下一步做什么）。这段文字会直接显示在聊天窗口里。`

/** 随用户输入注入的提醒文本；比兜底提醒短，每轮只挂一次。 */
const DEFAULT_USER_TURN_TEXT = `进度播报（本轮开始）：执行过程中每完成一个阶段，或累计约 {{every}} 次工具调用，先用 1–2 句中文向用户说明现在在做什么、刚确认了什么、下一步做什么；这段文字会直接显示在聊天窗口里。`

const DEFAULTS = {
  every: 4,
  maxRemindersPerTurn: 12,
  injectPrompt: true,
  promptText: DEFAULT_PROMPT_TEXT,
  nudgeText: DEFAULT_NUDGE_TEXT,
  nudgeOnUserTurn: false,
  userTurnText: DEFAULT_USER_TURN_TEXT,
  nudgeOnToolCalls: false,
}

/**
 * 插件的可编辑配置。`ctx.settings` 把这份 schema 投影成表单，控制面板
 * （client.js）通过 `settings.mutate` 把路径级改动写回 profile patch，
 * 再由 Loader 重新 apply —— 面板保存即生效，且不需要额外存储。
 */
export const Config = Schema.object({
  nudgeOnUserTurn: Schema.boolean()
    .default(DEFAULTS.nudgeOnUserTurn)
    .description('每条用户输入时，随该轮消息注入一条进度提醒（默认关闭）'),
  userTurnText: Schema.string()
    .role('textarea')
    .default(DEFAULT_USER_TURN_TEXT)
    .description('随用户输入注入的提醒文本，支持 {{every}} 占位符'),
  nudgeOnToolCalls: Schema.boolean()
    .default(DEFAULTS.nudgeOnToolCalls)
    .description('按工具调用次数注入提醒（默认关闭；开启后由下面的步频控制）'),
  every: Schema.number()
    .min(2)
    .max(50)
    .step(1)
    .default(DEFAULTS.every)
    .description('每累计多少次工具调用注入一次提醒（仅 nudgeOnToolCalls 开启时生效，最小 2）'),
  maxRemindersPerTurn: Schema.number()
    .min(0)
    .max(200)
    .step(1)
    .default(DEFAULTS.maxRemindersPerTurn)
    .description('单个计数周期内最多注入多少次工具调用提醒；0 表示关掉这一路'),
  injectPrompt: Schema.boolean()
    .default(DEFAULTS.injectPrompt)
    .description('是否注册常驻的 system prompt 进度规则'),
  promptText: Schema.string()
    .role('textarea')
    .default(DEFAULT_PROMPT_TEXT)
    .description('常驻进度规则文本，支持 {{every}} 占位符'),
  nudgeText: Schema.string()
    .role('textarea')
    .default(DEFAULT_NUDGE_TEXT)
    .description('工具调用提醒文本，支持 {{every}} / {{count}} 占位符'),
})

/** section 顺序：persona 0，其它插件指令 2，工具声明 100–199；取 4 保证位于工具之前。 */
const PROMPT_SECTION_ORDER = 4

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

let fallbackId = 0

/** 与 dsh-llm 的 createUserMessage 等价的最小实现（不依赖宿主包）。 */
function createNoticeMessage(text, kind, summary) {
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `progress-beat-${Date.now()}-${++fallbackId}`
  return deepFreeze({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, form: 'notice', summary },
  })
}

function resolveConfig(input) {
  const merged = { ...DEFAULTS, ...(input ?? {}) }
  const every = Number(merged.every)
  merged.every = Number.isInteger(every) && every >= 2 ? every : DEFAULTS.every
  const max = Number(merged.maxRemindersPerTurn)
  merged.maxRemindersPerTurn = Number.isInteger(max) && max >= 0 ? max : DEFAULTS.maxRemindersPerTurn
  merged.injectPrompt = merged.injectPrompt !== false
  merged.nudgeOnUserTurn = merged.nudgeOnUserTurn === true
  merged.nudgeOnToolCalls = merged.nudgeOnToolCalls === true
  if (typeof merged.userTurnText !== 'string' || merged.userTurnText.trim() === '') {
    merged.userTurnText = DEFAULT_USER_TURN_TEXT
  }
  if (typeof merged.promptText !== 'string' || merged.promptText.trim() === '') {
    merged.promptText = DEFAULT_PROMPT_TEXT
  }
  if (typeof merged.nudgeText !== 'string' || merged.nudgeText.trim() === '') {
    merged.nudgeText = DEFAULT_NUDGE_TEXT
  }
  return merged
}

const fill = (text, vars) =>
  text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match))

export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  // 让宿主为这一行按 Config schema 自动生成配置页；控制面板（client.js）挂在
  // 该页面上。settings 缺席时插件照常工作，只是没有可视化入口。
  const settings = ctx.get?.('settings')
  if (typeof settings?.configure === 'function') {
    try {
      ctx.effect(settings.configure({ auto: true }), 'progress-beat: settings page')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-progress-beat: 无法注册配置页策略: ${String(error)}`)
    }
  }

  if (resolved.injectPrompt) {
    const text = fill(resolved.promptText, { every: resolved.every })
    if (typeof ctx.systemPrompt?.section !== 'function') {
      ctx.logger?.error?.(
        'dsh-progress-beat: systemPrompt 服务不可用，进度规则未注入（插件需声明 inject: ["systemPrompt"]）。',
      )
    } else {
      try {
        ctx.systemPrompt.section({ name: 'dsh-progress-beat/progress', order: PROMPT_SECTION_ORDER, text })
      } catch (error) {
        ctx.logger?.error?.(`dsh-progress-beat: 注册 system prompt section 失败: ${String(error)}`)
      }
    }
  }

  /** 每个 agent 一份计数：{ calls, reminders }。 */
  const state = new WeakMap()

  function bucket(agent) {
    let entry = state.get(agent)
    if (entry === undefined) {
      entry = { calls: 0, reminders: 0 }
      state.set(agent, entry)
    }
    return entry
  }

  function observe(exec) {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return undefined
    const entry = bucket(agent)
    entry.calls += 1
    if (entry.calls % resolved.every !== 0) return undefined
    if (entry.reminders >= resolved.maxRemindersPerTurn) return undefined
    entry.reminders += 1
    return createNoticeMessage(
      fill(resolved.nudgeText, { count: entry.calls, every: resolved.every }),
      'progress-beat',
      `进度播报 · 已 ${entry.calls} 次工具调用`,
    )
  }

  // 工具调用计数注入：默认关闭。只有开启时才挂这个钩子，关掉时插件在整个
  // 工具链阶段不产生任何上下文。
  if (resolved.nudgeOnToolCalls) {
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const nudge = observe(exec)
      const downstream = await next()
      if (nudge === undefined) return downstream
      if (downstream?.kind === 'block') {
        return {
          kind: 'block',
          feedback: downstream.feedback,
          additionalContexts: [nudge, ...(downstream.additionalContexts ?? [])],
        }
      }
      return { ...downstream, additionalContexts: [nudge, ...(downstream?.additionalContexts ?? [])] }
    })
  }

  /** 每个 agent 已经处理过的 turn 号，用来保证「每轮只注入一次」。 */
  const turnSeen = new WeakMap()

  // 用户输入开启新一轮：清零计数；开启用户轮提醒时，在这一轮的入口 step 随消息挂一条。
  // 两路都关时连这个钩子都不注册——此时插件只贡献一个 system prompt section。
  if (resolved.nudgeOnUserTurn || resolved.nudgeOnToolCalls) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, messages, turn, step } = payload
    const isUserTurn = Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user')
    // `turn` 缺失时退化用 step 0 判断，避免每个 step 都当成新一轮而反复注入。
    const firstStepOfTurn = Number.isInteger(turn) ? turn !== turnSeen.get(agent) : step === 0
    if (isUserTurn && firstStepOfTurn) {
      turnSeen.set(agent, turn)
      state.delete(agent)
    }
    const decision = await next()
    if (!isUserTurn || !firstStepOfTurn || !resolved.nudgeOnUserTurn) return decision
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const nudge = createNoticeMessage(
      fill(resolved.userTurnText, { every: resolved.every }),
      'progress-beat',
      '进度播报 · 本轮开始时提醒',
    )
    // 保留 startsRequestSeries 等字段，只追加消息。
    return { ...decision, messages: [...decision.messages, nudge] }
  })
  }
}
