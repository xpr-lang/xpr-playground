import { EditorView, keymap } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { setDiagnostics } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { autocompletion } from '@codemirror/autocomplete'
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'
import { xprLanguage } from './xpr-lang'
import { xprCompletions } from './xpr-completions'
import { JsWorkerRuntime } from './runtimes'
import type { RuntimeAdapter } from './runtimes'
import * as storage from './storage'

// ===== Examples =====
type Example = { label: string; category: string; expr: string; ctx: string }

const EXAMPLES: Record<string, Example> = {
  map: {
    label: 'Map: double array',
    category: 'Basics',
    expr: '[1, 2, 3].map(x => x * 2)',
    ctx: '{}',
  },
  filter: {
    label: 'Filter active items',
    category: 'Basics',
    expr: 'items.filter(x => x.active).map(x => x.name)',
    ctx: JSON.stringify(
      {
        items: [
          { name: 'Widget', active: true },
          { name: 'Gadget', active: false },
          { name: 'Doohickey', active: true },
        ],
      },
      null,
      2
    ),
  },
  template: {
    label: 'Template literal',
    category: 'Basics',
    expr: '`Hello ${name}, you have ${count} items`',
    ctx: JSON.stringify({ name: 'Alice', count: 3 }, null, 2),
  },
  optional: {
    label: 'Optional chaining',
    category: 'Basics',
    expr: 'user?.address?.city ?? "unknown"',
    ctx: JSON.stringify({ user: { address: null } }, null, 2),
  },
  reduce: {
    label: 'Reduce: sum prices',
    category: 'Basics',
    expr: 'items.reduce((sum, x) => sum + x.price, 0)',
    ctx: JSON.stringify({ items: [{ price: 10 }, { price: 20 }, { price: 5 }] }, null, 2),
  },
  let_bindings: {
    label: 'Let bindings',
    category: 'Basics',
    expr: 'let items = [1,2,3,4,5]; let big = items.filter(x => x > 2); big.map(x => x * 10)',
    ctx: '{}',
  },
  spread_merge: {
    label: 'Spread merge',
    category: 'Basics',
    expr: '{...defaults, ...overrides}',
    ctx: JSON.stringify({ defaults: { color: 'blue', size: 10 }, overrides: { color: 'red' } }, null, 2),
  },
  date_formatting: {
    label: 'Date formatting',
    category: 'Dates (v0.3)',
    expr: 'formatDate(parseDate("2024-06-15T10:30:45Z"), "yyyy-MM-dd HH:mm:ss")',
    ctx: '{}',
  },
  regex_extraction: {
    label: 'Regex: extract all matches',
    category: 'Regex (v0.3-v0.4)',
    expr: 'matchAll("Order #123, Order #456, Order #789", "\\\\d+")',
    ctx: '{}',
  },
  regex_literals: {
    label: 'Regex literals',
    category: 'Regex (v0.3-v0.4)',
    expr: 'let emails = ["alice@example.com", "not-an-email", "bob@test.org"]; emails.filter(s => /^[\\w.]+@[\\w.]+$/.test(s))',
    ctx: '{}',
  },
  destructuring: {
    label: 'Object destructuring',
    category: 'Destructuring (v0.4)',
    expr: 'let {name, age = 0} = user; `${name} is ${age}`',
    ctx: JSON.stringify({ user: { name: 'Alice', age: 30 } }, null, 2),
  },
  destructuring_map: {
    label: 'Destructuring in map',
    category: 'Destructuring (v0.4)',
    expr: 'users.map(({name, role}) => `${name} (${role})`)',
    ctx: JSON.stringify(
      {
        users: [
          { name: 'Alice', role: 'admin' },
          { name: 'Bob', role: 'viewer' },
          { name: 'Carol', role: 'editor' },
        ],
      },
      null,
      2
    ),
  },
  math_constants: {
    label: 'Math constants (PI, pow)',
    category: 'Math (v0.5)',
    expr: 'let radius = 5; let area = PI * pow(radius, 2); round(area * 100) / 100',
    ctx: '{}',
  },
  collection_helpers: {
    label: 'Collection helpers (compact, unique)',
    category: 'Collections (v0.5)',
    expr: 'let data = [3, null, 1, null, 4, 1, 5]; data.compact().unique().sortBy(x => x)',
    ctx: '{}',
  },
  type_checking: {
    label: 'Type checking (partition)',
    category: 'Type Checking (v0.5)',
    expr: 'let values = [1, "two", null, [3]]; values.partition(x => isNumber(x))',
    ctx: '{}',
  },
  negative_indexing_spread: {
    label: 'Negative indexing + spread',
    category: 'Negative Indexing (v0.5)',
    expr: 'let nums = [3, 1, 4, 1, 5, 9]; [nums[-1], max(...nums)]',
    ctx: '{}',
  },
}

// Examples whose category is not in this list are silently skipped.
const CATEGORY_ORDER: readonly string[] = [
  'Basics',
  'Dates (v0.3)',
  'Regex (v0.3-v0.4)',
  'Destructuring (v0.4)',
  'Math (v0.5)',
  'Collections (v0.5)',
  'Type Checking (v0.5)',
  'Negative Indexing (v0.5)',
]

// ===== CodeMirror theme =====
// All colors come from CSS variables, so swapping `:root[data-theme]` repaints
// the editor for free. The `dark` flag below is the only thing that cannot be
// CSS-driven (it influences CodeMirror's internal heuristics for selection /
// cm-darkMode class), so we build two theme objects and hot-swap via Compartment.
const themeRules = {
  '&': {
    flex: '1',
    minHeight: '0',
    background: 'transparent',
    color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
    fontSize: '13.5px',
    lineHeight: '1.65',
  },
  '.cm-content': {
    padding: '14px 16px',
    caretColor: 'var(--accent)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-placeholder': {
    color: 'var(--text-subtle)',
  },
  '.cm-keyword': { color: 'var(--purple)', fontWeight: '600' },
  '.cm-number': { color: 'var(--orange)' },
  '.cm-string': { color: 'var(--green)' },
  '.cm-operator': { color: 'var(--accent)' },
  '.cm-variableName': { color: 'var(--text)' },
  '.cm-punctuation': { color: 'var(--text-muted)' },
} as const

const xprThemeDark = EditorView.theme(themeRules, { dark: true })
const xprThemeLight = EditorView.theme(themeRules, { dark: false })

const themeCompartment = new Compartment()

type Theme = 'light' | 'dark'

function getEffectiveTheme(): Theme {
  const explicit = document.documentElement.dataset.theme
  if (explicit === 'light' || explicit === 'dark') return explicit
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function buildCodeMirrorTheme(mode: Theme) {
  return mode === 'dark' ? xprThemeDark : xprThemeLight
}

// ===== DOM refs =====
const outputJs = document.getElementById('output-js') as HTMLPreElement
const evalStatus = document.getElementById('eval-status') as HTMLSpanElement
const examplesSelect = document.getElementById('examples-select') as HTMLSelectElement
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement
const toast = document.getElementById('toast') as HTMLDivElement
const exprEditorEl = document.getElementById('expr-editor')
const ctxEditorEl = document.getElementById('ctx-editor')
if (!exprEditorEl || !ctxEditorEl) {
  console.error('XPR Playground: missing #expr-editor or #ctx-editor mount point')
  throw new Error('Missing editor mount points')
}

// ===== Theme bootstrap =====
const STORAGE_KEY_THEME = 'xpr-theme'

function loadStoredTheme(): Theme | null {
  const stored = localStorage.getItem(STORAGE_KEY_THEME)
  return stored === 'light' || stored === 'dark' ? stored : null
}

const storedTheme = loadStoredTheme()
if (storedTheme) {
  document.documentElement.dataset.theme = storedTheme
}

// ===== Runtime adapter =====
// W2.5: `JsWorkerRuntime` off-loads `xpr.evaluate` to a persistent Web
// Worker so pathological expressions stall the worker, not the main thread.
// `JsDirectRuntime` is kept exported as a future opt-in fallback (Phase D).
const runtime: RuntimeAdapter = new JsWorkerRuntime()

// ===== CodeMirror editors =====
const initialTheme = getEffectiveTheme()

const exprView = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      ...xprLanguage,
      themeCompartment.of(buildCodeMirrorTheme(initialTheme)),
      autocompletion({ override: [xprCompletions] }),
      keymap.of([...defaultKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) scheduleEval()
      }),
    ],
  }),
  parent: exprEditorEl,
})

const ctxView = new EditorView({
  state: EditorState.create({
    doc: '{}',
    extensions: [
      json(),
      themeCompartment.of(buildCodeMirrorTheme(initialTheme)),
      keymap.of([...defaultKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) scheduleEval()
      }),
    ],
  }),
  parent: ctxEditorEl,
})

function applyCodeMirrorTheme(mode: Theme): void {
  const theme = buildCodeMirrorTheme(mode)
  const effect = themeCompartment.reconfigure(theme)
  exprView.dispatch({ effects: effect })
  ctxView.dispatch({ effects: effect })
}

// ===== Editor value helpers =====
function getExprValue(): string {
  return exprView.state.doc.toString()
}

function getCtxValue(): string {
  return ctxView.state.doc.toString()
}

function setExprValue(value: string): void {
  exprView.dispatch({
    changes: { from: 0, to: exprView.state.doc.length, insert: value },
  })
}

function setCtxValue(value: string): void {
  ctxView.dispatch({
    changes: { from: 0, to: ctxView.state.doc.length, insert: value },
  })
}

// ===== Evaluation =====
async function evaluate(): Promise<void> {
  const expr = getExprValue().trim()
  const ctxRaw = getCtxValue().trim()

  clearExprDiagnostics()

  if (!expr) {
    setOutput(outputJs, null, true)
    setStatus('', '')
    return
  }

  let ctx: unknown = {}
  if (ctxRaw && ctxRaw !== '{}') {
    try {
      ctx = JSON.parse(ctxRaw)
    } catch {
      setOutput(outputJs, 'Invalid JSON in context', false)
      setStatus('JSON error', 'error')
      return
    }
  }

  const result = await runtime.evaluate(expr, ctx as Record<string, unknown>)
  const elapsed = result.durationMs

  if (result.success) {
    setOutput(outputJs, formatResult(result.value), true)
    setStatus(`${elapsed.toFixed(1)}ms`, 'ok')
    return
  }

  const msg = result.error?.message ?? 'Unknown error'
  setOutput(outputJs, msg, false)
  setStatus(`error · ${elapsed.toFixed(1)}ms`, 'error')
  if (result.error?.position !== undefined) {
    setExprDiagnostic(result.error.position, msg)
  }
}

// ===== Inline diagnostics (CodeMirror lint) =====
// setDiagnostics auto-installs the lint state field on first dispatch
// (@codemirror/lint maybeEnableLint), so adding a linter(...) extension
// would create a no-op callback that wipes our imperative diagnostics on
// every doc change.
function clearExprDiagnostics(): void {
  exprView.dispatch(setDiagnostics(exprView.state, []))
}

function setExprDiagnostic(position: number, message: string): void {
  const docLen = exprView.state.doc.length
  const from = Math.min(position, docLen)
  const to = Math.min(from + 1, docLen)
  const diagnostic: Diagnostic = { from, to, severity: 'error', message }
  exprView.dispatch(setDiagnostics(exprView.state, [diagnostic]))
}

function formatResult(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, null, 2)
}

function setOutput(el: HTMLPreElement, text: string | null, ok: boolean): void {
  if (text === null) {
    el.innerHTML = '<span class="placeholder">—</span>'
    el.classList.remove('is-error')
  } else {
    el.textContent = text
    el.classList.toggle('is-error', !ok)
  }
}

function setStatus(text: string, cls: '' | 'ok' | 'error'): void {
  evalStatus.textContent = text
  evalStatus.className = 'eval-status' + (cls ? ` ${cls}` : '')
}

// ===== Debounce =====
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleEval(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void evaluate()
    updateHash()
  }, 300)
  scheduleSave()
}

// W2.6: 1s storage debounce is independent of the 300ms eval debounce.
// Eval/hash should feel live; storage writes can lag without UX impact.
function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    storage.save({
      expr: getExprValue(),
      ctx: getCtxValue(),
      runtimes: ['js'],
    })
  }, 1000)
}

// ===== URL Hash sharing =====
// Format (locked decision #10):
//   v=2: `#v=2&e=<b64url>&c=<b64url>&r=<csv>` where <b64url> is base64url-encoded
//        fflate zlib bytes (level 9). <csv> is the active runtime list.
//   v=1: legacy `#e=<b64>&c=<b64>` UTF-8-safe base64. Decode-only; we no longer emit it.
// v=1 URLs must keep working forever, so b64DecodeUtf8 is preserved verbatim from W1.8.

// W1.8 UTF-8-safe base64 helpers — retained for v=1 decode back-compat.
// Produces the same bytes as the old `btoa(unescape(encodeURIComponent(s)))`,
// so any pre-existing `#e=...&c=...` link continues to decode identically.
function b64EncodeUtf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

function b64DecodeUtf8(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)))
}

// RFC 4648 §5 base64url: replace `+/` with `-_`, strip `=` padding.
// Chunked for-of avoids spread-arg stack-size limits on large buffers and is
// safe for `noUncheckedIndexedAccess` (Uint8Array iterators yield `number`).
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

type DecodedState = { expr: string; ctx: string; runtimes: string[] }

function encodeStateV2(expr: string, ctx: string, runtimes: readonly string[]): string {
  const e = bytesToBase64Url(zlibSync(strToU8(expr), { level: 9 }))
  const c = bytesToBase64Url(zlibSync(strToU8(ctx), { level: 9 }))
  const r = runtimes.join(',')
  return `#v=2&e=${e}&c=${c}&r=${r}`
}

function decodeState(rawHash: string): DecodedState | null {
  const body = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  if (!body) return null
  const params = new URLSearchParams(body)

  if (params.get('v') === '2') {
    const e = params.get('e')
    if (!e) return null
    try {
      const expr = strFromU8(unzlibSync(base64UrlToBytes(e)))
      const c = params.get('c')
      const ctx = c ? strFromU8(unzlibSync(base64UrlToBytes(c))) : '{}'
      const rRaw = params.get('r')
      const runtimes = rRaw ? rRaw.split(',').filter(Boolean) : ['js']
      return { expr, ctx, runtimes }
    } catch {
      return null
    }
  }

  const e1 = params.get('e')
  if (e1) {
    try {
      const c1 = params.get('c')
      return {
        expr: b64DecodeUtf8(e1),
        ctx: c1 ? b64DecodeUtf8(c1) : '{}',
        runtimes: ['js'],
      }
    } catch {
      return null
    }
  }

  return null
}

function updateHash(): void {
  const expr = getExprValue()
  const ctx = getCtxValue()
  if (!expr && !ctx) return
  // Multi-runtime UI does not exist yet (W3 wave). Hard-coded to `['js']`;
  // future wiring just needs to pass the user's selected runtime list.
  history.replaceState(null, '', encodeStateV2(expr, ctx, ['js']))
}

// ===== Toast =====
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string): void {
  toast.textContent = msg
  toast.classList.add('show')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.classList.remove('show')
  }, 2000)
}

// ===== Share =====
shareBtn.addEventListener('click', () => {
  updateHash()
  const url = window.location.href
  navigator.clipboard.writeText(url).then(
    () => showToast('Link copied!'),
    () => {
      showToast('Copy this URL: ' + url)
    }
  )
})

// ===== Theme toggle =====
themeToggleBtn.addEventListener('click', () => {
  const next: Theme = getEffectiveTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem(STORAGE_KEY_THEME, next)
  applyCodeMirrorTheme(next)
})

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (loadStoredTheme()) return
  applyCodeMirrorTheme(getEffectiveTheme())
})

// ===== Examples =====
function populateExamples(): void {
  const groups = new Map<string, Array<{ key: string; label: string }>>()
  for (const [key, { label, category }] of Object.entries(EXAMPLES)) {
    let bucket = groups.get(category)
    if (!bucket) {
      bucket = []
      groups.set(category, bucket)
    }
    bucket.push({ key, label })
  }

  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Examples…'
  examplesSelect.appendChild(placeholder)

  for (const category of CATEGORY_ORDER) {
    const items = groups.get(category)
    if (!items) continue
    const optgroup = document.createElement('optgroup')
    optgroup.label = category
    for (const { key, label } of items) {
      const option = document.createElement('option')
      option.value = key
      option.textContent = label
      optgroup.appendChild(option)
    }
    examplesSelect.appendChild(optgroup)
  }
}

examplesSelect.addEventListener('change', () => {
  const key = examplesSelect.value
  if (!key) return
  const example = EXAMPLES[key]
  if (!example) return
  setExprValue(example.expr)
  setCtxValue(example.ctx)
  examplesSelect.value = ''
  void evaluate()
  updateHash()
  exprView.focus()
})

// ===== Init =====
// Restoration precedence (W2.6): URL hash > localStorage > default example.
// Hash represents explicit intent (shared link, deep link); localStorage is
// just "last open tab" history that should never override a deep-linked URL.
function init(): void {
  populateExamples()

  const fromHash = decodeState(window.location.hash)
  if (fromHash) {
    setExprValue(fromHash.expr)
    setCtxValue(fromHash.ctx)
    void evaluate()
    return
  }

  const stored = storage.load()
  if (stored) {
    setExprValue(stored.expr)
    setCtxValue(stored.ctx)
    void evaluate()
    return
  }

  const def = EXAMPLES['filter']
  if (!def) {
    console.error('XPR Playground: missing default example "filter"')
    return
  }
  setExprValue(def.expr)
  setCtxValue(def.ctx)
  void evaluate()
}

init()
