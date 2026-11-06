/**
 * dsh-progress-beat · 控制面板（浏览器半侧）
 *
 * 注册进插件管理页的两个配置位：`plugins.bundle.config`（键 = 包名，整包配置页）
 * 与 `plugins.row.config`（键 = `<包名>#<行 id>`，列表行上的「配置」控件），
 * 另有一个独立的 `settings.section` 页面。
 *
 * 数据面来自宿主注入的 `ctx.configForms`：它把 Host 插件 Config 的 schema
 * 投影成一个共享表单，`getSnapshot()` 给出 { value, base, user, writable }，
 * `mutate(ops)` 把路径级改动写回 profile patch 并由 Loader 热应用 —— 所以
 * 面板保存就是真正的配置变更，不需要插件自己造一份存储。
 *
 * 布局按插件的三个机制分组，每组是一个可折叠的 `<details>`：
 *   1. 常驻进度规则（system prompt section）：开关 + 文案 + 步频 + 插入位置；
 *   2. 用户轮提醒（pre-step 注入）：开关 + 文案 + 每几轮注入一次；
 *   3. 沉默提醒（pre-step 注入）：开关 + 节奏预设 + 调用/时间阈值 + 预算 + 文案。
 * 折叠态只留机制名与开关，其余控件收进组内；微调项（最小间隔、滴灌间隔）
 * 再收进组内的「高级」折叠。
 *
 * 不 import 任何 `@deepseek-ai/*` Client 包：宿主原语会变，而纯 JS 插件没有
 * 类型检查，写错的 require 会直接让整个 slot entry 崩掉。样式只用
 * `--dsw-alias-*` 主题 token，跟随亮/暗色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-progress-beat',
  factory(require) {
    // 诊断锚点：模块真的被浏览器加载时才会置位。页面控制台里查
    // `window.__DSH_PROGRESS_BEAT_PANEL__` 即可区分「未加载」「旧模块」与「未注册」——
    // 带 BUILD 标记说明拿到的是哪一版面板。
    const BUILD = 'silence-1'
    globalThis.__DSH_PROGRESS_BEAT_PANEL__ = `loaded@`
    const React = require('react')
    const h = React.createElement

    /** 面板的 Loader 行 id，同时也是 settings 命名空间（Host Config 投影的键）。 */
    const ENTRY_ID = 'dsh-progress-beat'
    /** `plugins.row.config` 的键：`<包名>#<行 id>`。 */
    const PANEL_KEY = 'dsh-progress-beat#dsh-progress-beat'
    /** `plugins.bundle.config` 的键：bundle 自己的包名。 */
    const BUNDLE_KEY = 'dsh-progress-beat'
    /** 本插件独占的词典命名空间。 */
    const NS = 'progress-beat'

    /** Config 缺省值的前端副本：仅在宿主还没读到 base 时兜底显示。 */
    const FALLBACK = {
      injectPrompt: true,
      promptText: '',
      promptEvery: 6,
      sectionOrder: 4,
      nudgeOnUserTurn: false,
      userTurnText: '',
      nudgeEveryTurns: 1,
      nudgeOnToolCalls: true,
      every: 8,
      silentSeconds: 180,
      minGapSeconds: 60,
      maxRemindersPerTurn: 6,
      dripSeconds: 300,
      nudgeText: '',
    }

    /** 三档常用节奏：同时填「沉默调用阈值」与「规则步频」。 */
    const PRESETS = [
      { id: 'quiet', every: 12, promptEvery: 8 },
      { id: 'normal', every: 8, promptEvery: 6 },
      { id: 'dense', every: 4, promptEvery: 3 },
    ]

    /** Config 的全部字段：全部重置与脏值判定都按这份清单走。 */
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

    /** 需要数字输入的字段；空串不能被 `Number('')` 当成 0 放过。 */
    const NUMERIC_FIELDS = new Set([
      'promptEvery',
      'sectionOrder',
      'nudgeEveryTurns',
      'every',
      'silentSeconds',
      'minGapSeconds',
      'maxRemindersPerTurn',
      'dripSeconds',
    ])

    const zh = {
      title: '进度播报',
      subtitle: '三个机制分别控制：常驻规则、用户轮提醒、沉默提醒。点标题展开细项。',
      summary: '长任务中途的进度播报规则',
      groupPrompt: '常驻进度规则',
      groupPromptHint: '随每次请求下发的系统提示词段落。',
      groupUserTurn: '用户轮提醒',
      groupUserTurnHint: '按轮次注入提醒，提醒模型这一轮边做边说。',
      groupToolCalls: '沉默提醒',
      groupToolCallsHint: '按「自上次播报以来」的调用次数与沉默时长触发，双阈值先到先算。',
      presets: '节奏预设',
      presetQuiet: '安静',
      presetNormal: '标准',
      presetDense: '密集',
      userTurnTextLabel: '提醒文本',
      userTurnTextHint: '随用户输入注入的文本，支持 {{every}} 占位符。',
      turnEveryLabel: '每几轮提醒一次',
      turnEveryHint: '1 表示每条用户输入都提醒；设成 3 就是每 3 轮提醒一次。',
      everyLabel: '沉默调用阈值',
      everyHint: '自上次播报以来累计这么多次工具调用就提醒（最小 2）。',
      silentSecondsLabel: '沉默时间阈值',
      silentSecondsHint: '秒。超过这么久没有播报也会提醒，与调用次数先到先算。',
      gapLabel: '最小提醒间隔',
      gapHint: '秒。两条提醒之间至少隔这么久，防止连续步骤反复注入。',
      budgetLabel: '每轮提醒预算',
      budgetHint: '每轮最多提醒多少条；0 表示关掉这一路。',
      dripLabel: '预算用尽后的间隔',
      dripHint: '秒。预算打满后不会彻底静音，只是按这个间隔变稀疏。',
      advanced: '高级',
      promptTextLabel: '规则文本',
      promptTextHint: '随每次请求下发。支持 {{every}} 占位符。',
      promptEveryLabel: '规则步频',
      promptEveryHint: '规则文本里「每累计约 N 次」的 N，最小 2。只管过程中的播报节奏，开局的「先说打算怎么做」不受此项影响。',
      sectionOrderLabel: '插入位置',
      sectionOrderHint: 'section 的排序号：人设 0、其它插件指令 2、本插件默认 4、工具声明 100 起。',
      nudgeTextLabel: '提醒文本',
      nudgeTextHint: '命中阈值时注入的提示。支持 {{count}} / {{seconds}} / {{every}} / {{remind}} 占位符。',
      overridden: '已覆盖',
      reset: '重置',
      resetAll: '全部重置',
      save: '保存',
      saving: '保存中',
      discard: '放弃',
      saved: '已保存，配置已热应用。',
      failed: '宿主没有接受这次写入，改动已保留供你修正。',
      unavailable: '宿主当前没有为这个插件提供可写表单；字段只读。',
      invalidNumber: '需要一个数字',
      loading: '正在读取配置…',
      notWritable: '当前部署不接受配置写入。',
      dirty: '有未保存的改动',
    }

    const en = {
      title: 'Progress beat',
      subtitle: 'Three mechanisms, configured separately: standing rule, user-turn nudge, silence nudge. Expand a group to edit it.',
      summary: 'Progress narration for long tool chains',
      groupPrompt: 'Standing rule',
      groupPromptHint: 'One system-prompt section sent with every request.',
      groupUserTurn: 'User-turn nudge',
      groupUserTurnHint: 'Injects a reminder on each configured user turn.',
      groupToolCalls: 'Silence nudge',
      groupToolCallsHint: 'Triggers on calls or wall-clock since the last narration, whichever comes first.',
      presets: 'Pace presets',
      presetQuiet: 'Quiet',
      presetNormal: 'Normal',
      presetDense: 'Dense',
      userTurnTextLabel: 'Reminder text',
      userTurnTextHint: 'Text injected with each user turn. Supports the {{every}} placeholder.',
      turnEveryLabel: 'Nudge every N turns',
      turnEveryHint: '1 reminds on every user turn; 3 reminds on every third turn.',
      everyLabel: 'Silent-call threshold',
      everyHint: 'Remind after this many tool calls without a narration (minimum 2).',
      silentSecondsLabel: 'Silence threshold',
      silentSecondsHint: 'Seconds. Also reminds when nothing was narrated for this long, whichever comes first.',
      gapLabel: 'Minimum gap',
      gapHint: 'Seconds between two reminders, so consecutive steps cannot spam.',
      budgetLabel: 'Reminders per turn',
      budgetHint: 'How many reminders a turn may use; 0 disables this mechanism.',
      dripLabel: 'Drip interval after budget',
      dripHint: 'Seconds. When the budget is spent the nudge does not go silent; it only gets sparser.',
      advanced: 'Advanced',
      promptTextLabel: 'Rule text',
      promptTextHint: 'Sent with every request. Supports the {{every}} placeholder.',
      promptEveryLabel: 'Rule cadence',
      promptEveryHint: 'The N in "every N calls" inside the rule text (minimum 2). It only sets the in-progress cadence; the opening "state the plan first" rule is not affected.',
      sectionOrderLabel: 'Insertion order',
      sectionOrderHint: 'Section order: persona 0, other plugin instructions 2, this plugin 4 by default, tool declarations from 100.',
      nudgeTextLabel: 'Reminder text',
      nudgeTextHint: 'Injected when a threshold is hit. Supports {{count}} / {{seconds}} / {{every}} / {{remind}}.',
      overridden: 'overridden',
      reset: 'Reset',
      resetAll: 'Reset all',
      save: 'Save',
      saving: 'Saving',
      discard: 'Discard',
      saved: 'Saved and hot-applied.',
      failed: 'The host did not accept this write; your edits were kept.',
      unavailable: 'The host serves no writable form for this plugin; fields are read-only.',
      invalidNumber: 'A number is required',
      loading: 'Reading configuration…',
      notWritable: 'This deployment does not accept configuration writes.',
      dirty: 'Unsaved changes',
    }

    const CSS = `
.pb-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.pb-head{display:flex;flex-direction:column;gap:2px}
.pb-title{margin:0;font-size:14px;font-weight:500}
.pb-sub,.pb-hint{color:var(--dsw-alias-label-secondary)}
.pb-hint{font-size:12px;line-height:18px;margin:0}
.pb-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.pb-groupHead{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none}
.pb-groupHead::-webkit-details-marker{display:none}
.pb-groupHead::before{content:'▸';color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1}
.pb-group[open]>.pb-groupHead::before{content:'▾'}
.pb-groupTitle{font-weight:500}
.pb-groupBody{display:flex;flex-direction:column;gap:12px;padding:0 12px 12px}
.pb-groupHint{margin:0}
.pb-advanced{border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;padding:0 10px}
.pb-advancedHead{display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;list-style:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.pb-advancedHead::-webkit-details-marker{display:none}
.pb-advancedHead::before{content:'▸';font-size:10px;line-height:1}
.pb-advanced[open]>.pb-advancedHead::before{content:'▾'}
.pb-advancedBody{display:flex;flex-direction:column;gap:12px;padding-bottom:10px}
.pb-sub{display:flex;flex-direction:column;gap:6px}
.pb-subHead{display:flex;align-items:center;gap:8px}
.pb-presets{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pb-presetsLabel{color:var(--dsw-alias-label-secondary);font-size:12px}
.pb-label{font-weight:500}
.pb-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.pb-spacer{flex:1}
.pb-input,.pb-textarea{box-sizing:border-box;width:100%;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;outline:none}
.pb-input:focus,.pb-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.pb-input{max-width:132px}
.pb-textarea{resize:vertical;min-height:88px;line-height:20px}
.pb-btn{font:inherit;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.pb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.pb-btn:disabled{opacity:.5;cursor:default}
.pb-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.pb-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.pb-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary)}
.pb-switch{position:relative;width:36px;height:20px;flex:none;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.pb-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.pb-switch:disabled{opacity:.5;cursor:default}
.pb-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:left .15s ease,background .15s ease}
.pb-switch[aria-checked="true"] .pb-knob{left:18px;background:var(--dsw-alias-bg-base)}
.pb-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pb-error{color:var(--dsw-alias-state-error-primary)}
.pb-ok{color:var(--dsw-alias-state-success-primary)}
.pb-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.pb-settingsSection{padding:8px 0 24px;max-width:720px}
`

    /** 表单缺席（宿主没提供 configForms）时的只读快照。 */
    const EMPTY_SNAPSHOT = {
      status: 'ready',
      value: {},
      base: {},
      user: undefined,
      revision: undefined,
      writable: false,
    }

    /** 订阅一份共享表单的同步快照；表单缺席时返回只读空快照。 */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => (form ? form.getSnapshot() : EMPTY_SNAPSHOT))
      React.useEffect(() => {
        if (!form) {
          setSnapshot(EMPTY_SNAPSHOT)
          return undefined
        }
        const off = form.subscribe(() => setSnapshot(form.getSnapshot()))
        setSnapshot(form.getSnapshot())
        return off
      }, [form])
      return snapshot
    }

    /** 某字段是否有用户覆盖（`user` 段出现过这个键）。 */
    function hasOverride(user, field) {
      return Boolean(user) && Object.prototype.hasOwnProperty.call(user, field)
    }

    /**
     * 控制面板本体。
     * @param props - slot 提供的 `t`、页面请求的 `view`，以及注入进来的 `entryForm`。
     */
    function ConfigPage(props) {
      const t = props.t
      const form = props.entryForm
      const snapshot = useFormSnapshot(form)
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [justSaved, setJustSaved] = React.useState(false)

      const value = snapshot.value || {}
      const base = snapshot.base || {}
      const user = snapshot.user
      // 宿主没把这份表单投影出来（最常见的原因：Config 字段漏了 .volatile()）时，
      // 快照停在 unavailable：此时字段只读，保存必然被拒，直接拦在前面。
      const unavailable = snapshot.status === 'unavailable'
      const writable = snapshot.writable !== false && !unavailable
      const dirty = Object.keys(draft).length > 0

      /** 当前显示值：draft 优先，其次写回值，最后兜底常量。 */
      const shown = (field) => {
        const edited = draft[field]
        if (edited !== undefined) {
          return edited.kind === 'unset' ? base[field] ?? FALLBACK[field] : edited.value
        }
        return value[field] ?? base[field] ?? FALLBACK[field]
      }
      const overridden = (field) => hasOverride(user, field) || draft[field]?.kind === 'set'
      const stage = (field, next) => {
        setJustSaved(false)
        setDraft((current) => ({ ...current, [field]: next }))
      }
      const stageValue = (field, next) => stage(field, { kind: 'set', value: next })
      const stageReset = (field) => stage(field, { kind: 'unset' })

      /** 一键填两个节奏：沉默提醒的调用阈值 + 常驻规则文案里的步频。 */
      const applyPreset = (preset) => {
        setJustSaved(false)
        setDraft((current) => ({
          ...current,
          every: { kind: 'set', value: preset.every },
          promptEvery: { kind: 'set', value: preset.promptEvery },
        }))
      }

      const save = async () => {
        if (!form) {
          setError(t('unavailable'))
          return
        }
        const ops = []
        for (const [field, edited] of Object.entries(draft)) {
          if (edited.kind === 'unset') {
            ops.push({ op: 'unset', path: [field] })
            continue
          }
          const next = edited.value
          // 空串会被 Number('') 变成 0，宿主 schema 的 min 随后拒写——先在本地拦住。
          if (NUMERIC_FIELDS.has(field) && (next === '' || next === null || !Number.isFinite(Number(next)))) {
            setError(t('invalidNumber'))
            return
          }
          ops.push({
            op: 'set',
            path: [field],
            value: NUMERIC_FIELDS.has(field) ? Number(next) : next,
          })
        }
        if (ops.length === 0) return
        setBusy(true)
        setError(null)
        // 用局部变量收结果：闭包里的 `error` 是上一次渲染的值，拿它判断会把
        // 刚写进去的具体报错再覆盖成通用文案。
        let failure = null
        try {
          const accepted = await form.mutate(ops)
          if (!accepted) failure = t('failed')
        } catch (cause) {
          failure = String(cause && cause.message ? cause.message : cause)
        }
        setBusy(false)
        if (failure === null) {
          setDraft({})
          setJustSaved(true)
        } else {
          setError(failure)
        }
      }

      // summary 视图由插件管理页在行的折叠态请求，只需一行说明。
      if (props.view === 'summary') return h('span', null, t('summary'))

      if (snapshot.status === 'loading') {
        return h('div', { className: 'pb-root' }, h('p', { className: 'pb-muted' }, t('loading')))
      }

      // ---------------------------------------------------------------- 控件
      const resetButton = (field) =>
        h('button', {
          key: `reset-${field}`,
          type: 'button',
          className: 'pb-btn',
          'data-reset': field,
          disabled: !writable || busy,
          onClick: () => stageReset(field),
        }, t('reset'))

      const overrideBadge = (field) => (overridden(field) ? h('span', { className: 'pb-badge' }, t('overridden')) : null)

      /** 折叠头里的机制开关：阻止点击冒泡到 <summary>，否则会顺带收起面板。 */
      const switchControl = (field, labelKey) =>
        h('button', {
          key: `switch-${field}`,
          type: 'button',
          className: 'pb-switch',
          role: 'switch',
          'data-field': field,
          'aria-checked': String(Boolean(shown(field))),
          'aria-label': t(labelKey),
          disabled: !writable || busy,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            stageValue(field, !Boolean(shown(field)))
          },
        }, h('span', { className: 'pb-knob' }))

      const textControl = (field, rows) =>
        h('textarea', {
          key: `text-${field}`,
          className: 'pb-textarea',
          'data-field': field,
          rows,
          spellCheck: false,
          value: String(shown(field) ?? ''),
          disabled: !writable || busy,
          onChange: (event) => stageValue(field, event.target.value),
        })

      const numberControl = (field, { min, max, step = 1 }) =>
        h('input', {
          key: `num-${field}`,
          className: 'pb-input',
          'data-field': field,
          type: 'number',
          min,
          max,
          step,
          value: shown(field),
          disabled: !writable || busy,
          onChange: (event) => stageValue(field, event.target.value === '' ? '' : Number(event.target.value)),
        })

      /** 组内一行：标题 + 覆盖徽标 + 重置 + 控件 + 说明。 */
      const sub = (field, labelKey, hintKey, control) =>
        h('div', { className: 'pb-sub', key: `sub-${field}` },
          h('div', { className: 'pb-subHead' },
            h('span', { className: 'pb-label' }, t(labelKey)),
            overrideBadge(field),
            h('span', { className: 'pb-spacer' }),
            resetButton(field),
          ),
          control,
          h('p', { className: 'pb-hint' }, t(hintKey)),
        )

      /** 一个机制组：折叠态只留机制名与开关。 */
      const group = (key, titleKey, hintKey, field, body) =>
        h('details', { className: 'pb-group', key: `group-${key}`, 'data-group': key },
          h('summary', { className: 'pb-groupHead' },
            h('span', { className: 'pb-groupTitle' }, t(titleKey)),
            overrideBadge(field),
            h('span', { className: 'pb-spacer' }),
            switchControl(field, titleKey),
          ),
          h('div', { className: 'pb-groupBody' },
            h('p', { className: 'pb-hint pb-groupHint' }, t(hintKey)),
            ...body,
          ),
        )

      // ------------------------------------------------------------ 三个机制
      const promptGroup = group('prompt', 'groupPrompt', 'groupPromptHint', 'injectPrompt', [
        sub('promptText', 'promptTextLabel', 'promptTextHint', textControl('promptText', 8)),
        sub('promptEvery', 'promptEveryLabel', 'promptEveryHint', numberControl('promptEvery', { min: 2, max: 50 })),
        sub('sectionOrder', 'sectionOrderLabel', 'sectionOrderHint', numberControl('sectionOrder', { min: 0, max: 99 })),
      ])

      const userTurnGroup = group('userTurn', 'groupUserTurn', 'groupUserTurnHint', 'nudgeOnUserTurn', [
        sub('userTurnText', 'userTurnTextLabel', 'userTurnTextHint', textControl('userTurnText', 4)),
        sub('nudgeEveryTurns', 'turnEveryLabel', 'turnEveryHint', numberControl('nudgeEveryTurns', { min: 1, max: 20 })),
      ])

      const advanced = h('details', { className: 'pb-advanced', key: 'advanced' },
        h('summary', { className: 'pb-advancedHead' }, t('advanced')),
        h('div', { className: 'pb-advancedBody' },
          sub('minGapSeconds', 'gapLabel', 'gapHint', numberControl('minGapSeconds', { min: 10, max: 600 })),
          sub('dripSeconds', 'dripLabel', 'dripHint', numberControl('dripSeconds', { min: 60, max: 3600 })),
        ),
      )

      const toolCallGroup = group('toolCalls', 'groupToolCalls', 'groupToolCallsHint', 'nudgeOnToolCalls', [
        h('div', { className: 'pb-presets', key: 'presets' },
          h('span', { className: 'pb-presetsLabel' }, t('presets')),
          ...PRESETS.map((preset) =>
            h('button', {
              key: preset.id,
              type: 'button',
              className: 'pb-btn',
              'data-preset': preset.id,
              'aria-pressed': String(
                Number(shown('every')) === preset.every && Number(shown('promptEvery')) === preset.promptEvery,
              ),
              disabled: !writable || busy,
              onClick: () => applyPreset(preset),
            }, `${t('preset' + preset.id[0].toUpperCase() + preset.id.slice(1))} · ${preset.every}`),
          ),
        ),
        sub('every', 'everyLabel', 'everyHint', numberControl('every', { min: 2, max: 100 })),
        sub('silentSeconds', 'silentSecondsLabel', 'silentSecondsHint', numberControl('silentSeconds', { min: 30, max: 3600 })),
        sub('maxRemindersPerTurn', 'budgetLabel', 'budgetHint', numberControl('maxRemindersPerTurn', { min: 0, max: 50 })),
        advanced,
        sub('nudgeText', 'nudgeTextLabel', 'nudgeTextHint', textControl('nudgeText', 5)),
      ])

      const footer = h('div', { className: 'pb-foot', key: 'foot' },
        h('button', {
          type: 'button',
          className: 'pb-btn pb-primary',
          disabled: !writable || busy || !dirty,
          onClick: save,
        }, busy ? t('saving') : t('save')),
        h('button', {
          type: 'button',
          className: 'pb-btn',
          disabled: !dirty || busy,
          onClick: () => {
            setDraft({})
            setError(null)
            setJustSaved(false)
          },
        }, t('discard')),
        h('button', {
          type: 'button',
          className: 'pb-btn',
          disabled: !writable || busy,
          onClick: () => {
            setJustSaved(false)
            setError(null)
            setDraft(Object.fromEntries(FIELDS.map((field) => [field, { kind: 'unset' }])))
          },
        }, t('resetAll')),
        h('span', { className: 'pb-spacer' }),
        error !== null
          ? h('span', { className: 'pb-error' }, error)
          : justSaved
            ? h('span', { className: 'pb-ok' }, t('saved'))
            : dirty
              ? h('span', { className: 'pb-muted' }, t('dirty'))
              : unavailable
                ? h('span', { className: 'pb-muted' }, t('unavailable'))
                : writable
                  ? null
                  : h('span', { className: 'pb-muted' }, t('notWritable')),
      )

      return h('div', { className: 'pb-root', 'data-build': BUILD },
        h('style', null, CSS),
        h('div', { className: 'pb-head' },
          h('h3', { className: 'pb-title' }, t('title')),
          h('p', { className: 'pb-hint' }, t('subtitle')),
        ),
        promptGroup,
        userTurnGroup,
        toolCallGroup,
        footer,
      )
    }

    /** 设置页里的独立入口：同一份表单，套一层页面内边距。 */
    function SettingsPage(props) {
      return h(
        'div',
        { className: 'pb-settingsSection' },
        h('style', null, CSS),
        ConfigPage(props),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'progress-beat: dictionaries')

        // 共享表单归宿主所有：借一份控制器，卸载时释放自己的订阅。
        // 取不到也不让面板消失——只是字段退化成只读，便于确认 UI 本身是否加载。
        const forms = ctx.get?.('configForms') ?? ctx.configForms
        const form = forms?.get?.(ENTRY_ID)
        if (form) ctx.effect(() => () => form.dispose(), 'progress-beat: config form')

        // 主入口：注册到组合包自己的配置位（以包名为键），面板直接铺在 bundle
        // 页面上，和 dsh-purge-community 的呈现方式一致。
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: BUNDLE_KEY,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => ({ entryForm: form }),
                },
                ConfigPage,
              ),
            ),
          'progress-beat: bundle config page',
        )

        // 次入口：行级配置位，插件列表里那一行会多出一个「配置」控件。
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  key: PANEL_KEY,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => ({ entryForm: form }),
                },
                ConfigPage,
              ),
            ),
          'progress-beat: row config page',
        )

        // 第二个入口：设置侧栏里一个独立页面，不依赖插件管理页是否被打开。
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'progress-beat',
                  order: 60,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => ({ entryForm: form }),
                },
                SettingsPage,
              ),
            ),
          'progress-beat: settings page',
        )
      },
    }
  },
})
