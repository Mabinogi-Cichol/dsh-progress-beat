/**
 * client.js 的冒烟测试：不依赖浏览器，用最小 mock 执行浏览器半侧。
 *
 * 覆盖：factory 能被 `window.__ModuleLoader__.load` 接收、apply 不抛错、
 * 面板注册到 `plugins.row.config` / `plugins.bundle.config` / `settings.section`、
 * 注入面含表单控制器、summary 与 page 两个视图；**三个机制组的折叠结构**
 * （折叠态只剩机制名与开关）；以及保存按钮的真实行为：成功清稿、宿主拒写保留草稿、
 * 异常透出宿主文案、空数值本地拦截、「全部重置」覆盖全部字段。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

const failures = []
const check = (label, condition) => {
  if (!condition) failures.push(label)
}

// ---- 最小 React：支持按调用序号复用 hook 槽位，从而能重渲染 -----------------
const stateSlots = new Map()
let renderIndex = 0
let needsRender = false

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

const React = {
  createElement,
  useState(initial) {
    const index = renderIndex
    renderIndex += 1
    if (!stateSlots.has(index)) stateSlots.set(index, typeof initial === 'function' ? initial() : initial)
    return [
      stateSlots.get(index),
      (next) => {
        stateSlots.set(index, typeof next === 'function' ? next(stateSlots.get(index)) : next)
        needsRender = true
      },
    ]
  },
  useEffect() {},
}

// ---- 捕获 load() 的注册 ----------------------------------------------------
let factory
let loadedId
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loadedId = spec.id
      factory = spec.factory
    },
  },
}

// client.js 使用 window.__ModuleLoader__.load 的普通脚本写法。
await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)

check('load() 被调用', typeof factory === 'function')
check('id 等于包名', loadedId === 'dsh-progress-beat')

// ---- mock 宿主 -------------------------------------------------------------
const registered = []
const served = []
let dictionaries

/** 可拨弄的共享表单桩：`mode` 控制宿主侧结果，`calls` 记录每次 mutate 的入参。 */
const form = {
  mode: 'accept',
  calls: [],
  getSnapshot: () => ({
    status: 'ready',
    value: { injectPrompt: true, promptEvery: 4, sectionOrder: 4, every: 4, nudgeEveryTurns: 1 },
    base: { promptEvery: 4, sectionOrder: 4, every: 4, nudgeEveryTurns: 1 },
    user: undefined,
    revision: 1,
    writable: true,
  }),
  subscribe: () => () => {},
  async mutate(ops) {
    this.calls.push(ops)
    if (this.mode === 'throw') throw new Error('boom')
    return this.mode === 'accept'
  },
  set: async () => true,
  unset: async () => true,
  dispose: () => {},
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    bind: () => (key) => key,
    register(ns, dicts) {
      dictionaries = { ns, dicts }
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      const effect = callback()
      return typeof effect === 'function' ? effect : () => {}
    },
    register(options, Component) {
      registered.push({ options, Component })
      return () => {}
    },
  },
  configForms: {
    get(entryId) {
      served.push(entryId)
      return form
    },
    whileServed(namespaces, register) {
      return register(new Set(namespaces))
    },
  },
}

// 面板通过 `ctx.get('configForms')` 取可选服务。
ctx.get = (name) => (name === 'configForms' ? ctx.configForms : undefined)

const module = factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

check('factory 返回对象', module && typeof module === 'object')
check(
  'inject 声明 slots 与 locale',
  Array.isArray(module.inject) && module.inject.includes('slots') && module.inject.includes('locale'),
)

module.apply(ctx)

check('词典注册到 progress-beat', dictionaries?.ns === 'progress-beat')
check('词典含中英文', Boolean(dictionaries?.dicts?.zh && dictionaries?.dicts?.en))
check(
  '词典含三个机制组的标题',
  ['groupPrompt', 'groupUserTurn', 'groupToolCalls'].every(
    (key) => dictionaries.dicts.zh[key] && dictionaries.dicts.en[key],
  ),
)
check('表单控制器按行 id 取得', served.includes('dsh-progress-beat'))

const panel = registered.find((item) => item.options.name === 'plugins.bundle.config')
check('注册到 plugins.bundle.config', Boolean(panel))
check('bundle 键为包名', panel?.options.key === 'dsh-progress-beat')
check('面板有本地化标题', typeof panel?.options.label === 'function' && panel.options.label() === 'title')
check('面板绑定词典命名空间', panel?.options.locale === 'progress-beat')

const injected = panel?.options.inject?.()
check('注入面带表单控制器', injected?.entryForm === form)

const settingsPage = registered.find((item) => item.options.name === 'settings.section')
check('注册到 settings.section', Boolean(settingsPage))
check('设置页也有本地化标题', settingsPage?.options.label() === 'title')
check('设置页同样注入表单控制器', settingsPage?.options.inject?.().entryForm === form)

// ---- 视图 ------------------------------------------------------------------
const t = (key) => `t:${key}`

function render(props) {
  const base = { view: 'page', t, entryForm: form, ...props }
  let tree
  for (let guard = 0; guard < 20; guard += 1) {
    needsRender = false
    renderIndex = 0
    tree = panel.Component(base)
    if (!needsRender) break
  }
  return tree
}

/** 把元素树摊平成数组，便于按 className / data-* 定位控件。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

const nodesOf = (tree) => flatten(tree)
const byClass = (tree, cls) =>
  nodesOf(tree).find((node) => String(node.props?.className ?? '').split(' ').includes(cls))
const byField = (tree, field) => nodesOf(tree).find((node) => node.props?.['data-field'] === field)
const byGroup = (tree, key) => nodesOf(tree).find((node) => node.props?.['data-group'] === key)
const byText = (tree, text) =>
  nodesOf(tree).find((node) => typeof node.type === 'string' && node.children?.[0] === text)

const summary = panel.Component({ view: 'summary', t, entryForm: form })
check('summary 视图返回一行文本', summary.type === 'span' && summary.children[0] === 't:summary')

const page = render({})
const serialized = JSON.stringify(page)

// ---- 三个机制组：结构、折叠态只剩标题与开关 --------------------------------
const GROUPS = [
  { key: 'prompt', title: 'groupPrompt', field: 'injectPrompt', parts: ['promptTextLabel', 'promptEveryLabel', 'sectionOrderLabel'] },
  { key: 'userTurn', title: 'groupUserTurn', field: 'nudgeOnUserTurn', parts: ['userTurnTextLabel', 'turnEveryLabel'] },
  { key: 'toolCalls', title: 'groupToolCalls', field: 'nudgeOnToolCalls', parts: ['everyLabel', 'silentSecondsLabel', 'budgetLabel', 'nudgeTextLabel'] },
]

for (const spec of GROUPS) {
  const node = byGroup(page, spec.key)
  check(`存在 ${spec.key} 折叠组`, node?.type === 'details')
  const head = node?.children?.[0]
  const body = node?.children?.[1]
  check(`${spec.key} 组折叠头是 summary`, head?.type === 'summary')
  check(`${spec.key} 组折叠头带组标题`, JSON.stringify(head).includes(`t:${spec.title}`))
  const headFields = nodesOf(head).filter((child) => child.props?.['data-field'])
  check(`${spec.key} 折叠头只有一个开关`, headFields.length === 1 && headFields[0].props['data-field'] === spec.field)
  check(`${spec.key} 折叠头没有数字输入`, nodesOf(head).every((child) => child.type !== 'input'))
  check(`${spec.key} 折叠头没有文本框`, nodesOf(head).every((child) => child.type !== 'textarea'))
  check(`${spec.key} 组正文挂在 details 内`, body?.type === 'div')
  for (const part of spec.parts) {
    check(`${spec.key} 组内含 ${part}`, JSON.stringify(body).includes(`t:${part}`))
  }
}
check('页面不再有旧的平铺字段行', !serialized.includes('pb-row'))

// 微调项收在「高级」折叠里，折叠头只有标题。
{
  const toolBody = byGroup(page, 'toolCalls')?.children?.[1]
  const advanced = nodesOf(toolBody).find(
    (node) => node.type === 'details' && String(node.props?.className ?? '').includes('pb-advanced'),
  )
  check('沉默提醒组内有高级折叠', Boolean(advanced))
  const advancedText = JSON.stringify(advanced)
  check('高级折叠含最小提醒间隔', advancedText.includes('t:gapLabel'))
  check('高级折叠含预算用尽后的间隔', advancedText.includes('t:dripLabel'))
  check('高级折叠头只有标题', advanced?.children?.[0]?.type === 'summary')
}
check('page 视图带保存按钮', serialized.includes('t:save'))
check('page 视图带样式表', serialized.includes('pb-root'))

// 开关落在折叠头上，点它不应冒泡去折叠面板。
{
  const toggle = byField(page, 'nudgeOnUserTurn')
  let prevented = false
  let stopped = false
  toggle.props.onClick({ preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) })
  check('机制开关阻止了 summary 的默认折叠', prevented && stopped)
}

// ---- 保存行为：成功 --------------------------------------------------------
{
  form.mode = 'accept'
  form.calls.length = 0

  let tree = render({})
  // 前面「开关不冒泡」那段已经暂存过一次开关，先放弃再重新暂存。
  byText(tree, 't:discard').props.onClick()
  tree = render({})
  byField(tree, 'nudgeOnUserTurn').props.onClick({ preventDefault() {}, stopPropagation() {} })
  tree = render({})
  check('暂存后保存按钮可用', byClass(tree, 'pb-primary').props.disabled === false)

  await byClass(tree, 'pb-primary').props.onClick()
  tree = render({})

  check(
    '保存写入单个布尔 op',
    form.calls.length === 1 &&
      form.calls[0].length === 1 &&
      form.calls[0][0].op === 'set' &&
      form.calls[0][0].path[0] === 'nudgeOnUserTurn' &&
      form.calls[0][0].value === true,
  )
  check('成功后提示已保存', String(byClass(tree, 'pb-ok')?.children ?? '').includes('t:saved'))
  check('成功后草稿清空、保存按钮禁用', byClass(tree, 'pb-primary').props.disabled === true)
}

// ---- 保存行为：宿主拒写（mutate 返回 false） --------------------------------
{
  form.mode = 'reject'
  form.calls.length = 0

  let tree = render({})
  byField(tree, 'nudgeOnToolCalls').props.onClick({ preventDefault() {}, stopPropagation() {} })
  tree = render({})
  await byClass(tree, 'pb-primary').props.onClick()
  tree = render({})

  check('拒写后给出通用失败文案', byClass(tree, 'pb-error')?.children?.[0] === 't:failed')
  check('拒写后草稿保留（保存仍可用）', byClass(tree, 'pb-primary').props.disabled === false)
}

// ---- 保存行为：宿主抛错（wire 层把拒绝转成异常） ----------------------------
{
  form.mode = 'throw'
  form.calls.length = 0

  let tree = render({})
  byText(tree, 't:discard').props.onClick()
  tree = render({})
  byField(tree, 'injectPrompt').props.onClick({ preventDefault() {}, stopPropagation() {} })
  tree = render({})
  await byClass(tree, 'pb-primary').props.onClick()
  tree = render({})

  check('异常文案原样透出', byClass(tree, 'pb-error')?.children?.[0] === 'boom')
}

// ---- 保存行为：空数值在本地被拦下 ------------------------------------------
{
  form.mode = 'accept'
  form.calls.length = 0

  let tree = render({})
  byText(tree, 't:discard').props.onClick()
  tree = render({})
  const everyInput = byField(tree, 'every')
  check('找到工具调用步频输入框', everyInput?.type === 'input')
  everyInput.props.onChange({ target: { value: '' } })
  tree = render({})
  await byClass(tree, 'pb-primary').props.onClick()
  tree = render({})

  check('空数值给出数字提示', byClass(tree, 'pb-error')?.children?.[0] === 't:invalidNumber')
  check('空数值不发起写入', form.calls.length === 0)
}

// ---- 保存行为：节奏预设同时填两个步频 --------------------------------------
{
  form.mode = 'accept'
  form.calls.length = 0

  let tree = render({})
  byText(tree, 't:discard').props.onClick()
  tree = render({})
  const quiet = nodesOf(tree).find((node) => node.props?.['data-preset'] === 'quiet')
  check('工具调用组内含节奏预设', Boolean(quiet))
  quiet.props.onClick()
  tree = render({})
  await byClass(tree, 'pb-primary').props.onClick()

  const ops = form.calls[0] ?? []
  const wrote = Object.fromEntries(ops.map((op) => [op.path[0], op.value]))
  check('预设同时写 every 与 promptEvery', wrote.every === 12 && wrote.promptEvery === 8)
}

// ---- 保存行为：全部重置覆盖全部字段 ----------------------------------------
{
  form.mode = 'accept'
  form.calls.length = 0

  let tree = render({})
  byText(tree, 't:discard').props.onClick()
  tree = render({})
  byText(tree, 't:resetAll').props.onClick()
  tree = render({})
  await byClass(tree, 'pb-primary').props.onClick()

  const ops = form.calls[0] ?? []
  const ALL = [
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
  check('全部重置发送 14 个 unset', ops.length === 14 && ops.every((op) => op.op === 'unset'))
  check(
    '全部重置覆盖所有字段',
    new Set(ops.map((op) => op.path[0])).size === 14 && ALL.every((field) => ops.some((op) => op.path[0] === field)),
  )
}

// ---- 只读快照：字段禁用、给出不可写提示 ------------------------------------
{
  // 换个面板实例：清掉前面几个场景留下的草稿与报错状态。
  stateSlots.clear()
  const readonlyForm = {
    ...form,
    mode: 'accept',
    getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: undefined, revision: 1, writable: false }),
  }
  const tree = render({ entryForm: readonlyForm })
  check('只读时保存禁用', byClass(tree, 'pb-primary').props.disabled === true)
  check('只读时给出不可写提示', nodesOf(tree).some((node) => node.children?.[0] === 't:notWritable'))
}

// ---- 宿主没有投影这份表单：提示 unavailable 并禁用保存 ---------------------
{
  // 宿主 describe() 里没有这个命名空间时，快照 status 停在 unavailable。
  stateSlots.clear()
  const unservedForm = {
    ...form,
    getSnapshot: () => ({ status: 'unavailable', value: {}, base: {}, user: undefined, revision: undefined, writable: true }),
  }
  const tree = render({ entryForm: unservedForm })
  check('未投影时保存禁用', byClass(tree, 'pb-primary').props.disabled === true)
  check('未投影时给出专属提示', nodesOf(tree).some((node) => node.children?.[0] === 't:unavailable'))
}

if (failures.length > 0) {
  console.error(`FAILED (${failures.length})`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('OK: client.js 冒烟通过')
console.log(`  id=${loadedId} key=${panel.options.key} groups=${GROUPS.length}`)
