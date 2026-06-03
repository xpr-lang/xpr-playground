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
import { xprHover } from './xpr-hover'
import { GoRuntime, JsWorkerRuntime, PythonRuntime } from './runtimes'
import { RuntimeMatrix } from './runtime-matrix'
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
const examplesSelect = document.getElementById('examples-select') as HTMLSelectElement
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement
const formatBtn = document.getElementById('format-btn') as HTMLButtonElement
const reevalBtn = document.getElementById('reeval-btn') as HTMLButtonElement
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement
const toast = document.getElementById('toast') as HTMLDivElement
const cursorStatusEl = document.getElementById('cursor-status') as HTMLSpanElement | null
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

// ===== Runtime matrix =====
// W3.4: JS (persistent worker) is always active; Python and Go are terminate-per-eval
// adapters that stay collapsed until the user activates their panel. The matrix owns
// every result panel and drives them through the shared evaluate() pipeline below.
const matrix = new RuntimeMatrix({
  adapters: {
    js: new JsWorkerRuntime(),
    python: new PythonRuntime(),
    go: new GoRuntime(),
  },
  hooks: {
    setEditorDiagnostic: setExprDiagnostic,
    offsetToLineCol,
  },
  onActiveChange: () => {
    scheduleSave()
    updateHash()
  },
  requestEvaluate: () => {
    void evaluate()
  },
})

// ===== CodeMirror editors =====
const initialTheme = getEffectiveTheme()

const exprView = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      ...xprLanguage,
      EditorView.contentAttributes.of({ 'aria-label': 'XPR expression editor' }),
      themeCompartment.of(buildCodeMirrorTheme(initialTheme)),
      autocompletion({ override: [xprCompletions] }),
      xprHover,
      keymap.of([...defaultKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) scheduleEval()
        if (update.docChanged || update.selectionSet) updateCursorStatus()
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
      EditorView.contentAttributes.of({ 'aria-label': 'JSON context editor' }),
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

// WCAG 2.1.1: .cm-scroller scrolls independently when content overflows (long
// context JSON on a narrow viewport), so make the scroll container itself
// keyboard-focusable to satisfy axe scrollable-region-focusable.
exprView.scrollDOM.tabIndex = 0
ctxView.scrollDOM.tabIndex = 0

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
    matrix.clearAll()
    return
  }

  let ctx: Record<string, unknown> = {}
  if (ctxRaw && ctxRaw !== '{}') {
    try {
      ctx = JSON.parse(ctxRaw) as Record<string, unknown>
    } catch {
      matrix.showContextError('Invalid JSON in context')
      return
    }
  }

  await matrix.evaluateAll(expr, ctx)
}

function offsetToLineCol(offset: number): { line: number; col: number } {
  const doc = exprView.state.doc
  // Clamp: stale errors from a previous longer doc can point past doc.length.
  const safe = Math.max(0, Math.min(offset, doc.length))
  const line = doc.lineAt(safe)
  return { line: line.number, col: safe - line.from + 1 }
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

function updateCursorStatus(): void {
  if (!cursorStatusEl) return
  const head = exprView.state.selection.main.head
  const line = exprView.state.doc.lineAt(head)
  cursorStatusEl.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`
}

// Tokenises into code | string | template | regex segments, then applies
// replacements only to `code` segments so string/template/regex contents are
// inviolate. Not an AST; small heuristic passes are enough for XPR.
function formatXprExpression(src: string): string {
  type SegType = 'code' | 'str' | 'tpl' | 'regex'
  const segments: Array<{ type: SegType; text: string }> = []
  let codeBuf = ''
  const flushCode = (): void => {
    if (codeBuf) {
      segments.push({ type: 'code', text: codeBuf })
      codeBuf = ''
    }
  }
  const isRegexContext = (buf: string): boolean => {
    const t = buf.trimEnd()
    if (!t) return true
    const last = t[t.length - 1]
    return /[=(,[{!&|<>+\-*%?:;]/.test(last ?? '')
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''
    if (ch === '"' || ch === "'") {
      flushCode()
      const q = ch
      let s = q
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < src.length) {
          s += (src[i] ?? '') + (src[i + 1] ?? '')
          i += 2
        } else {
          s += src[i] ?? ''
          i++
        }
      }
      if (i < src.length) { s += src[i] ?? ''; i++ }
      segments.push({ type: 'str', text: s })
      continue
    }
    if (ch === '`') {
      flushCode()
      let t = '`'
      i++
      while (i < src.length) {
        const c = src[i] ?? ''
        if (c === '`') { t += '`'; i++; break }
        if (c === '\\' && i + 1 < src.length) {
          t += c + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (c === '$' && src[i + 1] === '{') {
          t += '${'
          i += 2
          let depth = 1
          while (i < src.length && depth > 0) {
            const cc = src[i] ?? ''
            if (cc === '{') { depth++; t += cc; i++; continue }
            if (cc === '}') { depth--; t += cc; i++; continue }
            if (cc === '"' || cc === "'") {
              const qq = cc
              t += qq
              i++
              while (i < src.length && src[i] !== qq) {
                if (src[i] === '\\' && i + 1 < src.length) {
                  t += (src[i] ?? '') + (src[i + 1] ?? '')
                  i += 2
                } else { t += src[i] ?? ''; i++ }
              }
              if (i < src.length) { t += src[i] ?? ''; i++ }
              continue
            }
            t += cc
            i++
          }
          continue
        }
        t += c
        i++
      }
      segments.push({ type: 'tpl', text: t })
      continue
    }
    if (ch === '/' && isRegexContext(codeBuf)) {
      let r = '/'
      let j = i + 1
      let ok = false
      while (j < src.length) {
        const c = src[j] ?? ''
        if (c === '\\' && j + 1 < src.length) { r += c + (src[j + 1] ?? ''); j += 2; continue }
        if (c === '\n') break
        if (c === '/') { r += '/'; j++; ok = true; break }
        r += c
        j++
      }
      if (ok) {
        while (j < src.length && /[gimsuy]/.test(src[j] ?? '')) { r += src[j] ?? ''; j++ }
        flushCode()
        segments.push({ type: 'regex', text: r })
        i = j
        continue
      }
    }
    codeBuf += ch
    i++
  }
  flushCode()

  for (const seg of segments) {
    if (seg.type !== 'code') continue
    let s = seg.text
    s = s.replace(/\s*=>\s*/g, ' => ')
    s = s.replace(/\s*([=!<>]=|&&|\|\||\?\?)\s*/g, ' $1 ')
    s = s.replace(/\s*\|>\s*/g, ' |> ')
    // Single-char binary operators sandwiched between word/closing-paren on
    // the left and word/opening-paren/string-start on the right. Lookaround
    // prevents consuming the bordering chars so adjacent ops still match.
    s = s.replace(/(?<=[a-zA-Z0-9_)\]])\s*([+\-*/%<>])\s*(?=[a-zA-Z0-9_("\[`'])/g, ' $1 ')
    s = s.replace(/,(\S)/g, ', $1')
    seg.text = s
  }

  let out = segments.map(s => s.text).join('')
  if (out.length > 80 && out.includes('|>')) {
    out = out.replace(/ \|> /g, '\n  |> ')
  }
  return out
}

function onFormatClick(): void {
  const exprOld = getExprValue()
  const exprNew = formatXprExpression(exprOld)
  if (exprNew !== exprOld) {
    const head = exprView.state.selection.main.head
    const newPos = Math.min(head, exprNew.length)
    exprView.dispatch({
      changes: { from: 0, to: exprView.state.doc.length, insert: exprNew },
      selection: { anchor: newPos, head: newPos },
    })
  }

  const ctxOld = getCtxValue()
  try {
    const ctxNew = JSON.stringify(JSON.parse(ctxOld), null, 2)
    if (ctxNew !== ctxOld) {
      const head = ctxView.state.selection.main.head
      const newPos = Math.min(head, ctxNew.length)
      ctxView.dispatch({
        changes: { from: 0, to: ctxView.state.doc.length, insert: ctxNew },
        selection: { anchor: newPos, head: newPos },
      })
    }
  } catch {
    // Context is not valid JSON; leave it alone (don't fight the user).
  }
  exprView.focus()
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
      runtimes: matrix.getActiveRuntimes(),
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
  history.replaceState(null, '', encodeStateV2(expr, ctx, matrix.getActiveRuntimes()))
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

formatBtn.addEventListener('click', onFormatClick)

reevalBtn.addEventListener('click', () => void evaluate())

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
    matrix.restoreActiveRuntimes(fromHash.runtimes)
    return
  }

  const stored = storage.load()
  if (stored) {
    setExprValue(stored.expr)
    setCtxValue(stored.ctx)
    void evaluate()
    matrix.restoreActiveRuntimes(stored.runtimes)
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
updateCursorStatus()

// ===== W3.7: idle pre-warm of the Go runtime =====
// Warm the Go WASM during a browser idle slot so a later Go tab click is instant.
// Python/Pyodide is intentionally never pre-warmed (multi-MB silent download).
// Skipped when requestIdleCallback is absent (older Safari), or the connection
// reports Save-Data / slow-2g. The 1s timer keeps the warm off the first-paint
// critical path before yielding to a genuine idle slot (3s timeout as a backstop).
function schedulePrewarmGo(): void {
  if (typeof window.requestIdleCallback !== 'function') return

  type SaveDataConnection = { saveData?: boolean; effectiveType?: string }
  const connection = (navigator as Navigator & { connection?: SaveDataConnection }).connection
  if (connection?.saveData === true || connection?.effectiveType === 'slow-2g') return

  setTimeout(() => {
    window.requestIdleCallback(() => matrix.prewarmGo(), { timeout: 3000 })
  }, 1000)
}

schedulePrewarmGo()
