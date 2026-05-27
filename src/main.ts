import { Xpr, XprError } from '@xpr-lang/xpr'
import { EditorView, keymap } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { setDiagnostics } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { xprLanguage } from './xpr-lang'

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

// ===== Dark theme for CodeMirror =====
const xprTheme = EditorView.theme(
  {
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
      background: 'rgba(88, 166, 255, 0.02)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'inherit',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--accent)',
    },
    '.cm-selectionBackground': {
      background: 'rgba(88, 166, 255, 0.15)',
    },
    '&.cm-focused .cm-selectionBackground': {
      background: 'rgba(88, 166, 255, 0.2)',
    },
    '.cm-gutters': {
      display: 'none',
    },
    '.cm-placeholder': {
      color: 'var(--text-subtle)',
    },
    // Syntax highlighting token classes
    '.cm-keyword': { color: 'var(--purple)', fontWeight: '600' },
    '.cm-number': { color: 'var(--orange)' },
    '.cm-string': { color: 'var(--green)' },
    '.cm-operator': { color: 'var(--accent)' },
    '.cm-variableName': { color: 'var(--text)' },
    '.cm-punctuation': { color: 'var(--text-muted)' },
  },
  { dark: true }
)

// ===== DOM refs =====
const outputJs = document.getElementById('output-js') as HTMLPreElement
const evalStatus = document.getElementById('eval-status') as HTMLSpanElement
const examplesSelect = document.getElementById('examples-select') as HTMLSelectElement
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement
const toast = document.getElementById('toast') as HTMLDivElement
const exprEditorEl = document.getElementById('expr-editor')
const ctxEditorEl = document.getElementById('ctx-editor')
if (!exprEditorEl || !ctxEditorEl) {
  console.error('XPR Playground: missing #expr-editor or #ctx-editor mount point')
  throw new Error('Missing editor mount points')
}

// ===== XPR instance =====
const xpr = new Xpr()

// ===== CodeMirror editors =====
const exprView = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      ...xprLanguage,
      xprTheme,
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
      xprTheme,
      keymap.of([...defaultKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) scheduleEval()
      }),
    ],
  }),
  parent: ctxEditorEl,
})

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
function evaluate(): void {
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

  const t0 = performance.now()
  try {
    const result = xpr.evaluate(expr, ctx as Record<string, unknown>)
    const elapsed = performance.now() - t0
    const formatted = formatResult(result)
    setOutput(outputJs, formatted, true)
    setStatus(`${elapsed.toFixed(1)}ms`, 'ok')
  } catch (err) {
    const elapsed = performance.now() - t0
    const msg = err instanceof XprError ? err.message : String(err)
    setOutput(outputJs, msg, false)
    setStatus(`error · ${elapsed.toFixed(1)}ms`, 'error')
    setExprDiagnosticFromError(err, msg)
  }
}

// ===== Inline diagnostics (CodeMirror lint) =====
// XprError.position is a 0-indexed char offset (xpr-js/src/errors.ts:4),
// default -1 = no position. setDiagnostics auto-installs the lint state
// field on first dispatch (@codemirror/lint maybeEnableLint), so adding
// a linter(...) extension would create a no-op callback that wipes our
// imperative diagnostics on every doc change.
function clearExprDiagnostics(): void {
  exprView.dispatch(setDiagnostics(exprView.state, []))
}

function setExprDiagnosticFromError(err: unknown, msg: string): void {
  if (!(err instanceof XprError) || err.position < 0) return
  const docLen = exprView.state.doc.length
  const from = Math.min(err.position, docLen)
  const to = Math.min(from + 1, docLen)
  const diagnostic: Diagnostic = {
    from,
    to,
    severity: 'error',
    message: msg,
  }
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

function scheduleEval(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    evaluate()
    updateHash()
  }, 300)
}

// ===== URL Hash sharing =====
// UTF-8-safe base64 helpers (replaces deprecated escape/unescape).
// Produces same bytes as old `btoa(unescape(encodeURIComponent(s)))`
// so existing #e=...&c=... hashes still decode.
function b64EncodeUtf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

function b64DecodeUtf8(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)))
}

function encodeHash(expr: string, ctx: string): string {
  const e = b64EncodeUtf8(expr)
  const c = b64EncodeUtf8(ctx)
  return `#e=${e}&c=${c}`
}

function decodeHash(): { expr: string; ctx: string } | null {
  const hash = window.location.hash.slice(1)
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const e = params.get('e')
  const c = params.get('c')
  if (!e) return null
  try {
    return {
      expr: b64DecodeUtf8(e),
      ctx: c ? b64DecodeUtf8(c) : '{}',
    }
  } catch {
    return null
  }
}

function updateHash(): void {
  const expr = getExprValue()
  const ctx = getCtxValue()
  if (!expr && !ctx) return
  const hash = encodeHash(expr, ctx)
  history.replaceState(null, '', hash)
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
  evaluate()
  updateHash()
  exprView.focus()
})

// ===== Init =====
function init(): void {
  populateExamples()

  const fromHash = decodeHash()
  if (fromHash) {
    setExprValue(fromHash.expr)
    setCtxValue(fromHash.ctx)
    evaluate()
    return
  }

  const def = EXAMPLES['filter']
  if (!def) {
    console.error('XPR Playground: missing default example "filter"')
    return
  }
  setExprValue(def.expr)
  setCtxValue(def.ctx)
  evaluate()
}

init()
