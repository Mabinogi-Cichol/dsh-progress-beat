/**
 * dsh-progress-beat
 *
 * 目标：让 agent 在长时间「思考 + 工具调用」过程中持续输出用户可见的进度说明，
 * 而不是一路静默到任务结束才说话。
 *
 * 三条互补的机制，各自有独立的开关与节奏：
 *
 * 1. 常驻规则（请求侧 · `systemPrompt.section`）：跟随每次请求下发的系统提示词
 *    段落，要求模型完成一个阶段或连续约 `promptEvery` 次调用没有说明时先播报。
 *    段落位置由 `sectionOrder` 决定。
 * 2. 用户轮提醒（步骤侧 · `agent/pre-step`）：按轮次注入一条提醒，
 *    每 `nudgeEveryTurns` 轮一次。
 * 3. 沉默提醒（步骤侧 · `agent/pre-step`）：**按沉默算，不按调用总数算**。
 *    自上次播报以来累计 `every` 次工具调用、或沉默超过 `silentSeconds` 秒，
 *    二者先到先算；提醒之间至少隔 `minGapSeconds` 秒；每轮预算
 *    `maxRemindersPerTurn` 条，打满后不静音，退化成每 `dripSeconds` 秒一条。
 *
 * 为什么是「沉默」而不是「第 N 次调用」：用户感知的是「多久没看到文字」，
 * 而调用次数只是它的代理。固定取模会在模型刚说过话之后照样触发（纯浪费），
 * 也会在 200 次调用的长任务里触发 50 次（变成噪音）。
 *
 * 唯一的包依赖是 `@deepseek-ai/schemastery`：Config 必须是可投影的 schema，
 * 且每个字段都要 `.volatile()` —— 宿主只把 volatile 字段投影成可编辑表单，
 * 控制面板（client.js）才有可写的数据面。volatile 的配置变更由 Loader 就地
 * 推进运行中的引用（`loader/volatile-update`），不重跑 apply，所以 apply 里
 * 自己按新值重建挂载点。
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'progress-beat'

/** 等待 host 的 systemPrompt 服务就绪后再 apply。 */
export const inject = ['systemPrompt']

/** 默认进度规则文本；`{{every}}` 会被替换为配置里的规则步频。 */
const DEFAULT_PROMPT_TEXT = `进度可见性（强制）：
1. 预计需要多次工具调用时，在第一次调用之前先用一句中文说明打算怎么做。
2. 完成一个阶段（信息收集 → 实现 → 验证 → 收尾）时，或连续约 {{every}} 次工具调用都没有向用户说明过进展，必须先停下来说 1–2 句中文进度：现在在做什么、刚确认了什么结论、下一步做什么，然后再继续调用工具。
3. 进度说明是写给用户看的短句：不要复述工具输出，不要贴大段日志、命令或代码。
4. 进度说明不能替代最终答复；任务结束时仍要按用户要求给出完整结论。`

/** 沉默提醒文本；支持 `{{count}}` / `{{seconds}}` / `{{every}}` / `{{remind}}`。 */
const DEFAULT_NUDGE_TEXT = `进度播报提醒（系统）：你已经连续执行了 {{count}} 次工具调用、{{seconds}} 秒没有向用户说明进展（本轮第 {{remind}} 次提醒）。在继续调用任何工具之前，先用 1–2 句中文写出当前进度（在做什么 / 刚得到什么结论 / 下一步做什么）。这段文字会直接显示在聊天窗口里。`

/** 随用户输入注入的提醒文本；比兜底提醒短，按轮次节奏挂载。 */
const DEFAULT_USER_TURN_TEXT = `进度播报（本轮开始）：执行过程中每完成一个阶段，或累计约 {{every}} 次工具调用，先用 1–2 句中文向用户说明现在在做什么、刚确认了什么、下一步做什么；这段文字会直接显示在聊天窗口里。`

const DEFAULTS = {
  injectPrompt: true,
  promptText: DEFAULT_PROMPT_TEXT,
  promptEvery: 6,
  sectionOrder: 4,
  nudgeOnUserTurn: false,
  userTurnText: DEFAULT_USER_TURN_TEXT,
  nudgeEveryTurns: 1,
  nudgeOnToolCalls: true,
  every: 8,
  silentSeconds: 180,
  minGapSeconds: 60,
  maxRemindersPerTurn: 6,
  dripSeconds: 300,
  nudgeText: DEFAULT_NUDGE_TEXT,
}

/**
 * 插件的可编辑配置。字段按机制分组，与面板的三个折叠组一一对应。
 *
 * **每个字段都必须 `.volatile()`。** 宿主 `@deepseek-ai/dsh-settings` 的
 * `describe()` / `write()` 只投影 volatile 字段（`volatileForm()` /
 * `isVolatilePath()`）：没有 volatile 的命名空间根本进不了给浏览器的表单列表，
 * 写入会抛 `Plugin entry "<ns>" has no volatile fields`，面板只会看到
 * 「宿主没有接受这次写入」。这不是风格问题，是能否编辑的前置条件。
 *
 * volatile 的代价是「热更新不走重挂载」：Loader 遇到只改 volatile 字段的配置
 * 变更时，会把新值写进运行中 fiber 的引用并广播 `loader/volatile-update`，
 * **不重跑 apply**。所以下面的 apply 自己监听该事件按新值重建挂载点。
 */
export const Config = Schema.object({
  injectPrompt: Schema.boolean()
    .default(DEFAULTS.injectPrompt)
    .description('是否注册常驻的 system prompt 进度规则')
    .volatile(),
  promptText: Schema.string()
    .role('textarea')
    .default(DEFAULT_PROMPT_TEXT)
    .description('常驻进度规则文本，支持 {{every}} 占位符')
    .volatile(),
  promptEvery: Schema.number()
    .min(2)
    .max(50)
    .step(1)
    .default(DEFAULTS.promptEvery)
    .description('常驻规则与用户轮文案里 {{every}} 的取值：连续多少次工具调用没说明就该播报（最小 2）')
    .volatile(),
  sectionOrder: Schema.number()
    .min(0)
    .max(99)
    .step(1)
    .default(DEFAULTS.sectionOrder)
    .description('system prompt section 的排序号：人设 0，其它插件指令 2，默认 4，工具声明 100 起')
    .volatile(),
  nudgeOnUserTurn: Schema.boolean()
    .default(DEFAULTS.nudgeOnUserTurn)
    .description('每条用户输入时，随该轮消息注入一条进度提醒（默认关闭）')
    .volatile(),
  userTurnText: Schema.string()
    .role('textarea')
    .default(DEFAULT_USER_TURN_TEXT)
    .description('随用户输入注入的提醒文本，支持 {{every}} 占位符')
    .volatile(),
  nudgeEveryTurns: Schema.number()
    .min(1)
    .max(20)
    .step(1)
    .default(DEFAULTS.nudgeEveryTurns)
    .description('用户轮提醒每几轮注入一次：1 表示每轮都提醒，3 表示每三轮一次')
    .volatile(),
  nudgeOnToolCalls: Schema.boolean()
    .default(DEFAULTS.nudgeOnToolCalls)
    .description('沉默提醒：模型长时间不说明进展时注入一条硬提醒（默认关闭）')
    .volatile(),
  every: Schema.number()
    .min(2)
    .max(100)
    .step(1)
    .default(DEFAULTS.every)
    .description('沉默调用阈值：自上次播报以来累计多少次工具调用触发提醒（最小 2）')
    .volatile(),
  silentSeconds: Schema.number()
    .min(30)
    .max(3600)
    .step(1)
    .default(DEFAULTS.silentSeconds)
    .description('沉默时间阈值（秒）：超过这么久没有播报也会提醒，与调用次数先到先算')
    .volatile(),
  minGapSeconds: Schema.number()
    .min(10)
    .max(600)
    .step(1)
    .default(DEFAULTS.minGapSeconds)
    .description('两条沉默提醒之间的最小间隔（秒），防止连续步骤反复注入')
    .volatile(),
  maxRemindersPerTurn: Schema.number()
    .min(0)
    .max(50)
    .step(1)
    .default(DEFAULTS.maxRemindersPerTurn)
    .description('每轮沉默提醒的预算条数；0 表示关掉这一路，不为 0 时预算打满后会降级成慢速提醒')
    .volatile(),
  dripSeconds: Schema.number()
    .min(60)
    .max(3600)
    .step(1)
    .default(DEFAULTS.dripSeconds)
    .description('预算用尽后的慢速提醒间隔（秒）：不会彻底静音，只是变稀疏')
    .volatile(),
  nudgeText: Schema.string()
    .role('textarea')
    .default(DEFAULT_NUDGE_TEXT)
    .description('沉默提醒文本，支持 {{count}} / {{seconds}} / {{every}} / {{remind}} 占位符')
    .volatile(),
})

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

/** 一条 assistant 消息是否包含用户可见的文字（排除纯工具调用与 reasoning）。 */
function hasVisibleText(message) {
  if (message?.role !== 'assistant') return false
  const content = message.content
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  return content.some(
    (part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '',
  )
}

/**
 * 最近一次「播报」的标识（assistant 带文字的消​息）。
 * 用 message.id 做锚点，避免重复扫描同一段历史时误判成新播报。
 * @param messages - 本步骤即将送模型的会话消息。
 * @returns 播报消息的 id；没有则 undefined。
 */
function lastNarrationId(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (hasVisibleText(message)) return message.id ?? `index:${index}`
  }
  return undefined
}

/**
 * 自上次播报以来累计了多少次工具调用：从尾部往前数 `role === 'tool'` 的消息，
 * 遇到第一条带文字的 assistant 消息即停。
 * @param messages - 本步骤即将送模型的会话消息。
 * @returns 工具调用次数。
 */
function callsSinceNarration(messages) {
  let calls = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'tool') {
      calls += 1
      continue
    }
    if (hasVisibleText(message)) break
  }
  return calls
}

/** 取一个在 `[min, max]` 内的整数，否则回落默认值。 */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function resolveConfig(input) {
  const merged = { ...DEFAULTS, ...(input ?? {}) }
  merged.promptEvery = clampInt(merged.promptEvery, 2, 50, DEFAULTS.promptEvery)
  merged.sectionOrder = clampInt(merged.sectionOrder, 0, 99, DEFAULTS.sectionOrder)
  merged.nudgeEveryTurns = clampInt(merged.nudgeEveryTurns, 1, 20, DEFAULTS.nudgeEveryTurns)
  merged.every = clampInt(merged.every, 2, 100, DEFAULTS.every)
  merged.silentSeconds = clampInt(merged.silentSeconds, 30, 3600, DEFAULTS.silentSeconds)
  merged.minGapSeconds = clampInt(merged.minGapSeconds, 10, 600, DEFAULTS.minGapSeconds)
  merged.maxRemindersPerTurn = clampInt(merged.maxRemindersPerTurn, 0, 50, DEFAULTS.maxRemindersPerTurn)
  merged.dripSeconds = clampInt(merged.dripSeconds, 60, 3600, DEFAULTS.dripSeconds)
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

/**
 * 取出一个配置字段的普通值。
 *
 * volatile 字段在 `apply(ctx, config)` 里不是值而是引用（`{ get(), [write] }`），
 * `config.every` 直接参与运算会得到 `[object Object]` 或 NaN，所以统一在这里解包。
 * @param value - 原始配置字段。
 * @returns 字段当前值。
 */
function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * 把接线时的 config（字段可能是 volatile 引用）摊平成一份普通配置。
 * @param input - fiber 传入的 config。
 * @returns 归一化后的配置。
 */
function readConfig(input) {
  const raw = {}
  if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) raw[key] = unwrapVolatile(value)
  }
  return resolveConfig(raw)
}

export function apply(ctx, config) {
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

  /**
   * 当前时间。宿主若提供 `time` 服务就用它（测试里可以注入假时钟），
   * 否则退回 `Date.now()`。
   */
  function clock() {
    try {
      const service = ctx.get?.('time')
      if (service && typeof service.now === 'function') {
        const value = Number(service.now())
        if (Number.isFinite(value)) return value
      }
    } catch {
      // 服务缺席时 get() 会抛，直接回退。
    }
    return Date.now()
  }

  /**
   * 每个 agent 一份沉默状态：
   * - reminders：本轮已经注入过多少条沉默提醒（预算）；
   * - anchorAt：沉默计时起点（本轮开始 / 上次播报 / 上次提醒）；
   * - lastReminderAt：上一条提醒的时间，0 表示本轮还没提醒过；
   * - narrationId：最近一次计作「播报」的消息 id；
   * - turn / ordinal：已处理的 turn 号与本轮是第几个用户轮。
   */
  const state = new WeakMap()

  function bucket(agent) {
    let entry = state.get(agent)
    if (entry === undefined) {
      entry = {
        reminders: 0,
        anchorAt: clock(),
        lastReminderAt: 0,
        callsBaseline: 0,
        narrationId: undefined,
        turn: undefined,
        ordinal: 0,
      }
      state.set(agent, entry)
    }
    return entry
  }

  /** 当前配置下已经挂出去的东西；配置一变先整体拆掉再按新值重建。 */
  let mounted = []

  function mount(dispose) {
    if (typeof dispose === 'function') mounted.push(dispose)
  }

  function unmount() {
    const pending = mounted
    mounted = []
    for (const dispose of pending) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(`dsh-progress-beat: 撤下旧挂载点失败: ${String(error)}`)
      }
    }
  }

  /**
   * 按当前配置重建全部挂载点：常驻规则 section 与 pre-step 钩子。
   *
   * 三路都关时这里什么也不挂——插件此时不产生任何上下文。
   * @param resolved - 已归一化的配置。
   */
  function sync(resolved) {
    unmount()

    if (resolved.injectPrompt) {
      const text = fill(resolved.promptText, { every: resolved.promptEvery })
      if (typeof ctx.systemPrompt?.section !== 'function') {
        ctx.logger?.error?.(
          'dsh-progress-beat: systemPrompt 服务不可用，进度规则未注入（插件需声明 inject: ["systemPrompt"]）。',
        )
      } else {
        try {
          mount(
            ctx.systemPrompt.section({
              name: 'dsh-progress-beat/progress',
              order: resolved.sectionOrder,
              text,
            }),
          )
        } catch (error) {
          ctx.logger?.error?.(`dsh-progress-beat: 注册 system prompt section 失败: ${String(error)}`)
        }
      }
    }

    // 两路注入都关时连这个钩子都不注册——此时插件只贡献一个 system prompt section。
    if (resolved.nudgeOnUserTurn || resolved.nudgeOnToolCalls) {
      mount(
        ctx.on('agent/pre-step', async (payload, next) => {
          const { agent, messages, turn, step } = payload
          const now = clock()
          const trace = Array.isArray(messages) ? messages : undefined
          const isUserTurn = trace !== undefined && trace.some((message) => message?.source?.kind === 'user')
          const trackable = agent !== undefined && agent !== null && trace !== undefined

          let entry
          if (trackable) {
            entry = bucket(agent)
            const freshTurn = isUserTurn && (Number.isInteger(turn) ? turn !== entry.turn : step === 0)
            if (freshTurn) {
              entry.turn = turn
              entry.ordinal += 1
              entry.reminders = 0
              entry.callsBaseline = 0
              entry.anchorAt = now
              entry.lastReminderAt = 0
              // 记下上一轮的最后一句播报，避免在新轮入口把它误判成「刚播报过」。
              entry.narrationId = lastNarrationId(trace)
            } else {
              const narration = lastNarrationId(trace)
              if (narration !== undefined && narration !== entry.narrationId) {
                // 模型说过了：沉默计数与计时一起归零，本轮的预算不受影响。
                entry.narrationId = narration
                entry.callsBaseline = 0
                entry.anchorAt = now
                entry.lastReminderAt = 0
              }
            }
          }

          const decision = await next()
          if (!trackable || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

          const notices = []

          // ① 用户轮提醒：按轮次节奏，在该轮入口挂一条。
          const wantsUserTurn =
            resolved.nudgeOnUserTurn &&
            isUserTurn &&
            Number.isInteger(turn) &&
            turn === entry.turn &&
            (entry.ordinal - 1) % resolved.nudgeEveryTurns === 0
          if (wantsUserTurn) {
            notices.push(
              createNoticeMessage(
                fill(resolved.userTurnText, { every: resolved.promptEvery }),
                'progress-beat',
                `进度播报 · 第 ${entry.ordinal} 轮提醒`,
              ),
            )
            // 刚要求过播报，沉默时钟与间隔都从这一刻重新算。
            entry.anchorAt = now
            entry.lastReminderAt = 0
          } else if (resolved.nudgeOnToolCalls && resolved.maxRemindersPerTurn > 0) {
            // ② 沉默提醒：调用数与沉默时间先到先算，再过多重闸门。
            // 「自上次播报或上次提醒以来」的调用数：会话里数出来的是自上次播报
            // 以来的总数，减去提醒时记下的基线，才会在每次提醒后重新起算。
            const sinceNarration = callsSinceNarration(trace)
            const calls = Math.max(0, sinceNarration - entry.callsBaseline)
            const silentMs = Math.max(0, now - entry.anchorAt)
            const dueByCalls = calls >= resolved.every
            const dueByTime = silentMs >= resolved.silentSeconds * 1000
            const gapOk =
              entry.lastReminderAt === 0 || now - entry.lastReminderAt >= resolved.minGapSeconds * 1000
            const budgetLeft = entry.reminders < resolved.maxRemindersPerTurn
            // 预算用尽后不静音：退化成慢速滴灌。
            const dripDue =
              entry.lastReminderAt !== 0 && now - entry.lastReminderAt >= resolved.dripSeconds * 1000

            if (calls >= 1 && (dueByCalls || dueByTime) && gapOk && (budgetLeft || dripDue)) {
              entry.reminders += 1
              entry.lastReminderAt = now
              entry.anchorAt = now
              entry.callsBaseline = sinceNarration
              notices.push(
                createNoticeMessage(
                  fill(resolved.nudgeText, {
                    count: calls,
                    seconds: Math.round(silentMs / 1000),
                    every: resolved.every,
                    remind: entry.reminders,
                  }),
                  'progress-beat',
                  `进度播报 · 已 ${calls} 次工具调用未播报`,
                ),
              )
            }
          }

          if (notices.length === 0) return decision
          // 保留 startsRequestSeries 等字段，只追加消息。
          return { ...decision, messages: [...decision.messages, ...notices] }
        }),
      )
    }
  }

  // 面板保存写的是 profile patch 的 volatile 字段：Loader 只把新值灌进运行中
  // fiber 的引用并广播这个事件，不会重跑 apply。所以热更新在这里自己完成。
  ctx.on('loader/volatile-update', () => {
    try {
      sync(readConfig(config))
    } catch (error) {
      ctx.logger?.error?.(`dsh-progress-beat: 应用配置更新失败: ${String(error)}`)
    }
  })

  // 插件卸载时撤掉自己挂出去的 section / 钩子。
  if (typeof ctx.effect === 'function') ctx.effect(() => () => unmount(), 'progress-beat: mounted sections and hooks')

  sync(readConfig(config))
}
