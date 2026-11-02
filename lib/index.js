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
 * 不 import 任何 @deepseek-ai/* 包：插件必须能只靠宿主注入的 ctx 工作。
 */

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

const DEFAULTS = {
  every: 4,
  maxRemindersPerTurn: 12,
  injectPrompt: true,
  promptText: DEFAULT_PROMPT_TEXT,
  nudgeText: DEFAULT_NUDGE_TEXT,
}

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

  // 新的用户提示词开启新一轮：计数与播报配额清零。
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user')) {
      state.delete(agent)
    }
    return next()
  })
}
