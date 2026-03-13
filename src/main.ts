import { Xpr, XprError } from '@xpr-lang/xpr'
import { EditorView, keymap } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { xprLanguage } from './xpr-lang'

// ===== Examples =====
const EXAMPLES: Record<string, { expr: string; ctx: string }> = {
  map: {
    expr: '[1, 2, 3].map(x => x * 2)',
    ctx: '{}',
  },
  filter: {
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
    expr: '`Hello ${name}, you have ${count} items`',
    ctx: JSON.stringify({ name: 'Alice', count: 3 }, null, 2),
  },
  optional: {
    expr: 'user?.address?.city ?? "unknown"',
    ctx: JSON.stringify({ user: { address: null } }, null, 2),
  },
  reduce: {
    expr: 'items.reduce((sum, x) => sum + x.price, 0)',
    ctx: JSON.stringify({ items: [{ price: 10 }, { price: 20 }, { price: 5 }] }, null, 2),
  },
  let_bindings: {
    expr: 'let items = [1,2,3,4,5]; let big = items.filter(x => x > 2); big.map(x => x * 10)',
    ctx: '{}',
  },
  spread_merge: {
    expr: '{...defaults, ...overrides}',
    ctx: JSON.stringify({ defaults: { color: 'blue', size: 10 }, overrides: { color: 'red' } }, null, 2),
  },
}

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
  parent: document.getElementById('expr-editor')!,
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
  parent: document.getElementById('ctx-editor')!,
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

  if (!expr) {
    setOutput(outputJs, null, true)
    setStatus('', '')
    return
  }

  // Parse context
  let ctx: Record<string, unknown> = {}
  if (ctxRaw && ctxRaw !== '{}') {
    try {
      const parsed = JSON.parse(ctxRaw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        ctx = parsed as Record<string, unknown>
      } else {
        setOutput(outputJs, 'Context must be a JSON object', false)
        setStatus('Context error', 'error')
        return
      }
    } catch {
      setOutput(outputJs, 'Invalid JSON in context', false)
      setStatus('JSON error', 'error')
      return
    }
  }

  // Evaluate
  const t0 = performance.now()
  try {
    const result = xpr.evaluate(expr, ctx)
    const elapsed = performance.now() - t0
    const formatted = formatResult(result)
    setOutput(outputJs, formatted, true)
    setStatus(`${elapsed.toFixed(1)}ms`, 'ok')
  } catch (err) {
    const elapsed = performance.now() - t0
    const msg = err instanceof XprError ? err.message : String(err)
    setOutput(outputJs, msg, false)
    setStatus(`error · ${elapsed.toFixed(1)}ms`, 'error')
  }
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
function encodeHash(expr: string, ctx: string): string {
  const e = btoa(unescape(encodeURIComponent(expr)))
  const c = btoa(unescape(encodeURIComponent(ctx)))
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
      expr: decodeURIComponent(escape(atob(e))),
      ctx: c ? decodeURIComponent(escape(atob(c))) : '{}',
    }
  } catch {
    return null
  }
}

function updateHash(): void {
  const expr = getExprValue()
  const ctx = getCtxValue()
  if (!expr && !ctx) {
    history.replaceState(null, '', window.location.pathname)
    return
  }
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
  // Load from URL hash if present
  const fromHash = decodeHash()
  if (fromHash) {
    setExprValue(fromHash.expr)
    setCtxValue(fromHash.ctx)
    evaluate()
    return
  }

  // Default: load the filter example
  const def = EXAMPLES['filter']!
  setExprValue(def.expr)
  setCtxValue(def.ctx)
  evaluate()
}

init()
