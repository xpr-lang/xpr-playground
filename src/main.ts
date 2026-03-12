import { Xpr, XprError } from '@xpr-lang/xpr'

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
}

// ===== DOM refs =====
const exprEditor = document.getElementById('expr-editor') as HTMLTextAreaElement
const ctxEditor = document.getElementById('ctx-editor') as HTMLTextAreaElement
const outputJs = document.getElementById('output-js') as HTMLPreElement
const evalStatus = document.getElementById('eval-status') as HTMLSpanElement
const examplesSelect = document.getElementById('examples-select') as HTMLSelectElement
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement
const toast = document.getElementById('toast') as HTMLDivElement

// ===== XPR instance =====
const xpr = new Xpr()

// ===== Evaluation =====
function evaluate(): void {
  const expr = exprEditor.value.trim()
  const ctxRaw = ctxEditor.value.trim()

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
  const expr = exprEditor.value
  const ctx = ctxEditor.value
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
      // Fallback: select the URL
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
  exprEditor.value = example.expr
  ctxEditor.value = example.ctx
  examplesSelect.value = ''
  evaluate()
  updateHash()
  exprEditor.focus()
})

// ===== Input listeners =====
exprEditor.addEventListener('input', scheduleEval)
ctxEditor.addEventListener('input', scheduleEval)

// Tab key in editors inserts 2 spaces
function handleTab(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  e.preventDefault()
  const el = e.target as HTMLTextAreaElement
  const start = el.selectionStart
  const end = el.selectionEnd
  el.value = el.value.slice(0, start) + '  ' + el.value.slice(end)
  el.selectionStart = el.selectionEnd = start + 2
}

exprEditor.addEventListener('keydown', handleTab)
ctxEditor.addEventListener('keydown', handleTab)

// ===== Init =====
function init(): void {
  // Load from URL hash if present
  const fromHash = decodeHash()
  if (fromHash) {
    exprEditor.value = fromHash.expr
    ctxEditor.value = fromHash.ctx
    evaluate()
    return
  }

  // Default: load the filter example
  const def = EXAMPLES['filter']!
  exprEditor.value = def.expr
  ctxEditor.value = def.ctx
  evaluate()
}

init()
