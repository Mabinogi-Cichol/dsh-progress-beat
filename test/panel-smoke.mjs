/**
 * client.js 的冒烟测试：不依赖浏览器，用最小 mock 执行浏览器半侧。
 *
 * 覆盖：factory 能被 `window.__ModuleLoader__.load` 接收、apply 不抛错、
 * 面板注册到 `plugins.row.config` 且键为 `<包名>#<行 id>`、注入面含表单控制器、
 * summary 视图返回一行文本、page 视图渲染出各字段与保存控件。
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

// ---- 最小 React：只提供 client.js 用到的四个符号 -------------------------
const hooks = []
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}
const React = {
  createElement,
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    const entry = { value }
    hooks.push(entry)
    return [
      value,
      (next) => {
        entry.value = typeof next === 'function' ? next(entry.value) : next
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

const formStub = {
  getSnapshot: () => ({ status: 'ready', value: { every: 4 }, base: { every: 4 }, user: undefined, revision: 1, writable: true }),
  subscribe: () => () => {},
  mutate: async () => true,
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
      return formStub
    },
    whileServed(namespaces, register) {
      return register(new Set(namespaces))
    },
  },
}

// 面板通过 `ctx.get('configForms')` 取可选服务。
ctx.get = (name) => (name === 'configForms' ? ctx.configForms : undefined)

const module = factory((id) => {  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

check('factory 返回对象', module && typeof module === 'object')
check('inject 声明 slots 与 locale', Array.isArray(module.inject) && module.inject.includes('slots') && module.inject.includes('locale'))

module.apply(ctx)

check('词典注册到 progress-beat', dictionaries?.ns === 'progress-beat')
check('词典含中英文', Boolean(dictionaries?.dicts?.zh && dictionaries?.dicts?.en))
check('表单控制器按行 id 取得', served.includes('dsh-progress-beat'))

const panel = registered.find((item) => item.options.name === 'plugins.bundle.config')
check('注册到 plugins.bundle.config', Boolean(panel))
check('bundle 键为包名', panel?.options.key === 'dsh-progress-beat')
check('面板有本地化标题', typeof panel?.options.label === 'function' && panel.options.label() === 'title')
check('面板绑定词典命名空间', panel?.options.locale === 'progress-beat')

const injected = panel?.options.inject?.()
check('注入面带表单控制器', injected?.entryForm === formStub)

const settingsPage = registered.find((item) => item.options.name === 'settings.section')
check('注册到 settings.section', Boolean(settingsPage))
check('设置页也有本地化标题', settingsPage?.options.label() === 'title')
check('设置页同样注入表单控制器', settingsPage?.options.inject?.().entryForm === formStub)

// ---- 视图 ----------------------------------------------------------------
const t = (key) => `t:${key}`
const summary = panel.Component({ view: 'summary', t, entryForm: formStub })
check('summary 视图返回一行文本', summary.type === 'span' && summary.children[0] === 't:summary')

hooks.length = 0
const page = panel.Component({ view: 'page', t, entryForm: formStub })
const serialized = JSON.stringify(page)
const LABEL_KEYS = {
  every: 'everyLabel',
  maxRemindersPerTurn: 'maxRemindersLabel',
  injectPrompt: 'injectPromptLabel',
  promptText: 'promptTextLabel',
  nudgeText: 'nudgeTextLabel',
}
for (const [field, labelKey] of Object.entries(LABEL_KEYS)) {
  check(`page 视图渲染字段 ${field}`, serialized.includes(`t:${labelKey}`))
}
check('page 视图带保存按钮', serialized.includes('t:save'))
check('page 视图带样式表', serialized.includes('pb-root'))

if (failures.length > 0) {
  console.error(`FAILED (${failures.length})`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('OK: client.js 冒烟通过')
console.log(`  id=${loadedId} key=${panel.options.key} fields=5`)
