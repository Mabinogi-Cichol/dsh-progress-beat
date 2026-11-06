/**
 * dsh-progress-beat · 控制面板（浏览器半侧）
 *
 * 注册进插件管理页的 `plugins.row.config`（key = `<包名>#<行 id>`），于是
 * 插件列表里这一行会多出一个「配置」入口，打开就是这份表单。
 *
 * 数据面来自宿主注入的 `ctx.configForms`：它把 Host 插件 Config 的 schema
 * 投影成一个共享表单，`getSnapshot()` 给出 { value, base, user, writable }，
 * `mutate(ops)` 把路径级改动写回 profile patch 并由 Loader 热应用 —— 所以
 * 面板保存就是真正的配置变更，不需要插件自己造一份存储。
 *
 * 不 import 任何 `@deepseek-ai/*` Client 包：宿主原语会变，而纯 JS 插件没有
 * 类型检查，写错的 require 会直接让整个 slot entry 崩掉。样式只用
 * `--dsw-alias-*` 主题 token，跟随亮/暗色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-progress-beat',
  factory(require) {
    // 诊断锚点：模块真的被浏览器加载时才会置位。页面控制台里查
    // `window.__DSH_PROGRESS_BEAT_PANEL__` 即可区分「未加载」与「未注册」。
    globalThis.__DSH_PROGRESS_BEAT_PANEL__ = 'loaded'
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
      every: 4,
      maxRemindersPerTurn: 12,
      injectPrompt: true,
      nudgeOnUserTurn: true,
      nudgeOnToolCalls: false,
    }

    /** 三档常用节奏，一键填 draft。 */
    const PRESETS = [
      { id: 'quiet', every: 8 },
      { id: 'normal', every: 4 },
      { id: 'dense', every: 2 },
    ]

    const zh = {
      title: '进度播报',
      subtitle: '控制 agent 在长工具链中途主动说明进度的频率与措辞。',
      summary: '长任务中途的进度播报规则',
      presets: '节奏预设',
      presetQuiet: '安静',
      presetNormal: '标准',
      presetDense: '密集',
      nudgeOnUserTurnLabel: '随用户输入提醒',
      nudgeOnUserTurnHint: '每条用户输入时，随该轮消息注入一条提醒（默认开启）。',
      userTurnTextLabel: '用户轮提醒文本',
      userTurnTextHint: '随用户输入注入的文本，支持 {{every}} 占位符。',
      nudgeOnToolCallsLabel: '按工具调用注入',
      nudgeOnToolCallsHint: '开启后每累计若干次工具调用再注入一条提醒（默认关闭）。',
      everyLabel: '播报步频',
      everyHint: '仅上面的「按工具调用注入」开启时生效；累计这么多次调用注入一条提醒（最小 2）。',
      maxRemindersLabel: '单轮提醒上限',
      maxRemindersHint: '每次清零周期内最多注入多少条兜底提醒；0 表示关闭兜底，只靠常驻规则。',
      injectPromptLabel: '常驻进度规则',
      injectPromptHint: '关闭后不再向系统提示词注入规则，只剩按次数注入的硬提醒。',
      promptTextLabel: '常驻规则文本',
      promptTextHint: '随每次请求下发。支持 {{every}} 占位符。',
      nudgeTextLabel: '兜底提醒文本',
      nudgeTextHint: '命中步频时注入的提示。支持 {{every}} 与 {{count}} 占位符。',
      overridden: '已覆盖',
      reset: '重置',
      resetAll: '全部重置',
      save: '保存',
      saving: '保存中',
      discard: '放弃',
      saved: '已保存，配置已热应用。',
      failed: '宿主没有接受这次写入，改动已保留供你修正。',
      invalidNumber: '需要一个数字',
      loading: '正在读取配置…',
      notWritable: '当前部署不接受配置写入。',
      dirty: '有未保存的改动',
    }

    const en = {
      title: 'Progress beat',
      subtitle: 'Tune how often the agent narrates progress in the middle of a long tool chain.',
      summary: 'Progress narration for long tool chains',
      presets: 'Pace presets',
      presetQuiet: 'Quiet',
      presetNormal: 'Normal',
      presetDense: 'Dense',
      nudgeOnUserTurnLabel: 'Nudge on each user turn',
      nudgeOnUserTurnHint: 'Injects one reminder with the messages of every user turn (on by default).',
      userTurnTextLabel: 'User-turn reminder text',
      userTurnTextHint: 'Text injected with each user turn. Supports the {{every}} placeholder.',
      nudgeOnToolCallsLabel: 'Nudge on tool calls',
      nudgeOnToolCallsHint: 'Also inject a reminder every N tool calls (off by default).',
      everyLabel: 'Beat every N calls',
      everyHint: 'Only applies while "Nudge on tool calls" is on: one reminder every N calls (minimum 2).',
      maxRemindersLabel: 'Reminders per round',
      maxRemindersHint: 'How many hard reminders may be injected per reset cycle; 0 keeps only the standing rule.',
      injectPromptLabel: 'Standing prompt rule',
      injectPromptHint: 'When off, nothing is added to the system prompt and only the counted nudges remain.',
      promptTextLabel: 'Standing rule text',
      promptTextHint: 'Sent with every request. Supports the {{every}} placeholder.',
      nudgeTextLabel: 'Nudge text',
      nudgeTextHint: 'Injected whenever the beat is hit. Supports {{every}} and {{count}}.',
      overridden: 'overridden',
      reset: 'Reset',
      resetAll: 'Reset all',
      save: 'Save',
      saving: 'Saving',
      discard: 'Discard',
      saved: 'Saved and hot-applied.',
      failed: 'The host did not accept this write; your edits were kept.',
      invalidNumber: 'A number is required',
      loading: 'Reading configuration…',
      notWritable: 'This deployment does not accept configuration writes.',
      dirty: 'Unsaved changes',
    }

    const CSS = `
.pb-root{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.pb-head{display:flex;flex-direction:column;gap:2px}
.pb-title{margin:0;font-size:14px;font-weight:500}
.pb-sub,.pb-hint{color:var(--dsw-alias-label-secondary)}
.pb-hint{font-size:12px;line-height:18px}
.pb-presets{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pb-presetsLabel{color:var(--dsw-alias-label-secondary);font-size:12px}
.pb-row{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.pb-rowHead{display:flex;align-items:center;gap:8px}
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
      const writable = snapshot.writable !== false
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

      const applyPreset = (every) => {
        setJustSaved(false)
        setDraft((current) => ({ ...current, every: { kind: 'set', value: every } }))
      }

      const save = async () => {
        if (!form) return
        const ops = []
        for (const [field, edited] of Object.entries(draft)) {
          if (edited.kind === 'unset') {
            ops.push({ op: 'unset', path: [field] })
            continue
          }
          const next = edited.value
          if ((field === 'every' || field === 'maxRemindersPerTurn') && !Number.isFinite(Number(next))) {
            setError(t('invalidNumber'))
            return
          }
          ops.push({
            op: 'set',
            path: [field],
            value: field === 'every' || field === 'maxRemindersPerTurn' ? Number(next) : next,
          })
        }
        if (ops.length === 0) return
        setBusy(true)
        setError(null)
        let accepted = false
        try {
          accepted = await form.mutate(ops)
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
        setBusy(false)
        if (accepted) {
          setDraft({})
          setJustSaved(true)
        } else if (error === null) {
          setError(t('failed'))
        }
      }

      // summary 视图由插件管理页在行的折叠态请求，只需一行说明。
      if (props.view === 'summary') return h('span', null, t('summary'))

      if (snapshot.status === 'loading') {
        return h('div', { className: 'pb-root' }, h('p', { className: 'pb-muted' }, t('loading')))
      }

      const rows = []

      rows.push(
        h('div', { className: 'pb-presets', key: 'presets' },
          h('span', { className: 'pb-presetsLabel' }, t('presets')),
          ...PRESETS.map((preset) =>
            h('button', {
              key: preset.id,
              type: 'button',
              className: 'pb-btn',
              'aria-pressed': String(Number(shown('every')) === preset.every),
              disabled: !writable || busy,
              onClick: () => applyPreset(preset.every),
            }, `${t('preset' + preset.id[0].toUpperCase() + preset.id.slice(1))} · ${preset.every}`),
          ),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'nudgeOnUserTurn' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('nudgeOnUserTurnLabel')),
            overridden('nudgeOnUserTurn') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('nudgeOnUserTurn'),
            }, t('reset')),
            h('button', {
              type: 'button',
              className: 'pb-switch',
              role: 'switch',
              'aria-checked': String(Boolean(shown('nudgeOnUserTurn'))),
              'aria-label': t('nudgeOnUserTurnLabel'),
              disabled: !writable || busy,
              onClick: () => stageValue('nudgeOnUserTurn', !Boolean(shown('nudgeOnUserTurn'))),
            }, h('span', { className: 'pb-knob' })),
          ),
          h('p', { className: 'pb-hint' }, t('nudgeOnUserTurnHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'userTurnText' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('userTurnTextLabel')),
            overridden('userTurnText') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('userTurnText'),
            }, t('reset')),
          ),
          h('textarea', {
            className: 'pb-textarea',
            rows: 4,
            spellCheck: false,
            value: String(shown('userTurnText') ?? ''),
            disabled: !writable || busy,
            onChange: (event) => stageValue('userTurnText', event.target.value),
          }),
          h('p', { className: 'pb-hint' }, t('userTurnTextHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'nudgeOnToolCalls' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('nudgeOnToolCallsLabel')),
            overridden('nudgeOnToolCalls') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('nudgeOnToolCalls'),
            }, t('reset')),
            h('button', {
              type: 'button',
              className: 'pb-switch',
              role: 'switch',
              'aria-checked': String(Boolean(shown('nudgeOnToolCalls'))),
              'aria-label': t('nudgeOnToolCallsLabel'),
              disabled: !writable || busy,
              onClick: () => stageValue('nudgeOnToolCalls', !Boolean(shown('nudgeOnToolCalls'))),
            }, h('span', { className: 'pb-knob' })),
          ),
          h('p', { className: 'pb-hint' }, t('nudgeOnToolCallsHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'every' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('everyLabel')),
            overridden('every') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('every'),
            }, t('reset')),
          ),
          h('input', {
            className: 'pb-input',
            type: 'number',
            min: 2,
            max: 50,
            step: 1,
            value: shown('every'),
            disabled: !writable || busy,
            onChange: (event) => stageValue('every', event.target.value === '' ? '' : Number(event.target.value)),
          }),
          h('p', { className: 'pb-hint' }, t('everyHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'maxRemindersPerTurn' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('maxRemindersLabel')),
            overridden('maxRemindersPerTurn') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('maxRemindersPerTurn'),
            }, t('reset')),
          ),
          h('input', {
            className: 'pb-input',
            type: 'number',
            min: 0,
            max: 200,
            step: 1,
            value: shown('maxRemindersPerTurn'),
            disabled: !writable || busy,
            onChange: (event) =>
              stageValue('maxRemindersPerTurn', event.target.value === '' ? '' : Number(event.target.value)),
          }),
          h('p', { className: 'pb-hint' }, t('maxRemindersHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'injectPrompt' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('injectPromptLabel')),
            overridden('injectPrompt') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('injectPrompt'),
            }, t('reset')),
            h('button', {
              type: 'button',
              className: 'pb-switch',
              role: 'switch',
              'aria-checked': String(Boolean(shown('injectPrompt'))),
              'aria-label': t('injectPromptLabel'),
              disabled: !writable || busy,
              onClick: () => stageValue('injectPrompt', !Boolean(shown('injectPrompt'))),
            }, h('span', { className: 'pb-knob' })),
          ),
          h('p', { className: 'pb-hint' }, t('injectPromptHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'promptText' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('promptTextLabel')),
            overridden('promptText') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('promptText'),
            }, t('reset')),
          ),
          h('textarea', {
            className: 'pb-textarea',
            rows: 8,
            spellCheck: false,
            value: String(shown('promptText') ?? ''),
            disabled: !writable || busy,
            onChange: (event) => stageValue('promptText', event.target.value),
          }),
          h('p', { className: 'pb-hint' }, t('promptTextHint')),
        ),
      )

      rows.push(
        h('div', { className: 'pb-row', key: 'nudgeText' },
          h('div', { className: 'pb-rowHead' },
            h('span', { className: 'pb-label' }, t('nudgeTextLabel')),
            overridden('nudgeText') ? h('span', { className: 'pb-badge' }, t('overridden')) : null,
            h('span', { className: 'pb-spacer' }),
            h('button', {
              type: 'button',
              className: 'pb-btn',
              disabled: !writable || busy,
              onClick: () => stageReset('nudgeText'),
            }, t('reset')),
          ),
          h('textarea', {
            className: 'pb-textarea',
            rows: 5,
            spellCheck: false,
            value: String(shown('nudgeText') ?? ''),
            disabled: !writable || busy,
            onChange: (event) => stageValue('nudgeText', event.target.value),
          }),
          h('p', { className: 'pb-hint' }, t('nudgeTextHint')),
        ),
      )

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
            setDraft(
              Object.fromEntries(
                ['every', 'maxRemindersPerTurn', 'injectPrompt', 'promptText', 'nudgeText'].map((field) => [
                  field,
                  { kind: 'unset' },
                ]),
              ),
            )
          },
        }, t('resetAll')),
        h('span', { className: 'pb-spacer' }),
        error !== null
          ? h('span', { className: 'pb-error' }, error)
          : justSaved
            ? h('span', { className: 'pb-ok' }, t('saved'))
            : dirty
              ? h('span', { className: 'pb-muted' }, t('dirty'))
              : writable
                ? null
                : h('span', { className: 'pb-muted' }, t('notWritable')),
      )

      return h('div', { className: 'pb-root' },
        h('style', null, CSS),
        h('div', { className: 'pb-head' },
          h('h3', { className: 'pb-title' }, t('title')),
          h('p', { className: 'pb-hint' }, t('subtitle')),
        ),
        ...rows,
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
