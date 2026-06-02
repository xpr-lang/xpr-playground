// W3.4: orchestrates the three runtime adapters (JS worker, Python via Pyodide,
// Go via WASM) behind a single results UI. Desktop renders one panel per runtime
// side-by-side; mobile collapses to tabs (one panel visible). JS is always active
// with a first-paint eval; Python and Go stay collapsed until the user activates
// them (Locked Decision #12), at which point initialize() runs once and the panel
// joins every subsequent re-evaluation.

import type { EvaluationResult, RuntimeAdapter, RuntimeName } from './runtimes'

const RUNTIME_ORDER = ['js', 'python', 'go'] as const

type PanelState = 'collapsed' | 'loading' | 'ready'

interface PanelRefs {
  panel: HTMLElement
  output: HTMLPreElement
  status: HTMLElement
  tab: HTMLButtonElement
  loadBtn: HTMLButtonElement
  loadingText: HTMLElement | null
}

export interface RuntimeMatrixHooks {
  // The expression editor's inline diagnostic is JS-only: every runtime shares one
  // editor, so letting Python/Go also push markers would stack conflicting squiggles.
  setEditorDiagnostic(position: number, message: string): void
  offsetToLineCol(offset: number): { line: number; col: number }
}

export interface RuntimeMatrixOptions {
  adapters: Record<RuntimeName, RuntimeAdapter>
  hooks: RuntimeMatrixHooks
  onActiveChange(active: RuntimeName[]): void
  // Re-runs the full evaluate() pipeline (re-reads the editors, re-parses context).
  // Used after a lazy initialize() so the freshly-ready runtime is evaluated through
  // the same path as every other runtime instead of a divergent one-off code path.
  requestEvaluate(): void
}

export class RuntimeMatrix {
  private readonly adapters: Record<RuntimeName, RuntimeAdapter>
  private readonly hooks: RuntimeMatrixHooks
  private readonly onActiveChange: (active: RuntimeName[]) => void
  private readonly requestEvaluate: () => void
  private readonly refs: Record<RuntimeName, PanelRefs>
  private readonly active = new Set<RuntimeName>(['js'])
  private current: RuntimeName = 'js'
  // Bumped on every evaluateAll/clearAll; a render is dropped if its generation is
  // no longer current, so a slow Python eval cannot overwrite a newer JS result.
  private generation = 0

  constructor(options: RuntimeMatrixOptions) {
    this.adapters = options.adapters
    this.hooks = options.hooks
    this.onActiveChange = options.onActiveChange
    this.requestEvaluate = options.requestEvaluate
    this.refs = {
      js: queryRefs('js'),
      python: queryRefs('python'),
      go: queryRefs('go'),
    }
    this.wireEvents()
  }

  getActiveRuntimes(): RuntimeName[] {
    return RUNTIME_ORDER.filter((name) => this.active.has(name))
  }

  restoreActiveRuntimes(names: readonly string[]): void {
    for (const name of RUNTIME_ORDER) {
      if (name !== 'js' && names.includes(name) && !this.active.has(name)) {
        void this.activate(name)
      }
    }
  }

  async evaluateAll(expr: string, ctx: Record<string, unknown>): Promise<void> {
    const gen = ++this.generation
    const tasks: Array<Promise<void>> = []
    for (const name of this.active) {
      if (!this.adapters[name].isReady()) continue
      tasks.push(this.evaluateOne(name, expr, ctx, gen))
    }
    await Promise.all(tasks)
  }

  clearAll(): void {
    this.generation++
    for (const name of this.active) {
      this.setPanelState(name, 'ready')
      setOutput(this.refs[name].output, null, true)
      this.setStatus(name, '', '')
    }
  }

  showContextError(message: string): void {
    this.generation++
    for (const name of this.active) {
      this.setPanelState(name, 'ready')
      setOutput(this.refs[name].output, message, false)
      this.setStatus(name, 'error', 'error')
    }
  }

  private async activate(name: RuntimeName): Promise<void> {
    this.setCurrent(name)
    if (this.active.has(name)) return

    this.active.add(name)
    this.onActiveChange(this.getActiveRuntimes())

    const adapter = this.adapters[name]
    if (!adapter.isReady()) {
      this.setPanelState(name, 'loading')
      this.setLoadingProgress(name, 0)
      try {
        await adapter.initialize((p) => this.setLoadingProgress(name, p))
      } catch (err) {
        this.active.delete(name)
        this.onActiveChange(this.getActiveRuntimes())
        this.renderInitError(name, err)
        return
      }
    }

    this.setPanelState(name, 'ready')
    this.requestEvaluate()
  }

  private async evaluateOne(
    name: RuntimeName,
    expr: string,
    ctx: Record<string, unknown>,
    gen: number
  ): Promise<void> {
    let result: EvaluationResult
    try {
      result = await this.adapters[name].evaluate(expr, ctx)
    } catch (err) {
      if (gen !== this.generation) return
      this.setPanelState(name, 'ready')
      setOutput(this.refs[name].output, err instanceof Error ? err.message : String(err), false)
      this.setStatus(name, 'error', 'error')
      return
    }
    if (gen !== this.generation) return
    this.setPanelState(name, 'ready')
    this.renderResult(name, result)
  }

  private renderResult(name: RuntimeName, result: EvaluationResult): void {
    const output = this.refs[name].output
    const ms = result.durationMs

    if (result.success) {
      setOutput(output, formatResult(result.value), true)
      this.setStatus(name, `ok · ${ms.toFixed(1)}ms`, 'ok')
      return
    }

    const message = result.error?.message ?? 'Unknown error'
    const position = result.error?.position
    const loc = position !== undefined ? this.hooks.offsetToLineCol(position) : null
    renderError(output, message, loc)
    this.setStatus(name, `error · ${ms.toFixed(1)}ms`, 'error')
    if (name === 'js' && position !== undefined) {
      this.hooks.setEditorDiagnostic(position, message)
    }
  }

  private renderInitError(name: RuntimeName, err: unknown): void {
    this.setPanelState(name, 'ready')
    setOutput(this.refs[name].output, err instanceof Error ? err.message : String(err), false)
    this.setStatus(name, 'init failed', 'error')
  }

  private wireEvents(): void {
    for (const name of RUNTIME_ORDER) {
      this.refs[name].tab.addEventListener('click', () => void this.activate(name))
      this.refs[name].loadBtn.addEventListener('click', () => void this.activate(name))
    }
  }

  private setCurrent(name: RuntimeName): void {
    this.current = name
    for (const r of RUNTIME_ORDER) {
      const isCurrent = r === name
      this.refs[r].panel.classList.toggle('is-current', isCurrent)
      this.refs[r].tab.classList.toggle('is-current', isCurrent)
      this.refs[r].tab.setAttribute('aria-selected', String(isCurrent))
    }
  }

  private setPanelState(name: RuntimeName, state: PanelState): void {
    this.refs[name].panel.dataset.state = state
  }

  private setLoadingProgress(name: RuntimeName, progress: number): void {
    const el = this.refs[name].loadingText
    if (el) el.textContent = `Loading ${this.adapters[name].displayName}… ${Math.round(progress)}%`
  }

  private setStatus(name: RuntimeName, text: string, cls: '' | 'ok' | 'error'): void {
    const el = this.refs[name].status
    el.textContent = text
    el.className = 'result-panel-status eval-status' + (cls ? ` ${cls}` : '')
  }
}

function queryRefs(name: RuntimeName): PanelRefs {
  const panel = document.getElementById(`result-${name}`)
  const output = document.getElementById(`output-${name}`)
  const status = document.getElementById(`status-${name}`)
  const tab = document.getElementById(`tab-${name}`)
  const loadBtn = panel?.querySelector<HTMLButtonElement>('.result-panel-load')
  if (!panel || !(output instanceof HTMLPreElement) || !status || !(tab instanceof HTMLButtonElement) || !loadBtn) {
    throw new Error(`RuntimeMatrix: missing DOM nodes for runtime "${name}"`)
  }
  return {
    panel,
    output,
    status,
    tab,
    loadBtn,
    loadingText: panel.querySelector<HTMLElement>('.loading-text'),
  }
}

function formatResult(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, null, 2)
}

function setOutput(el: HTMLPreElement, text: string | null, ok: boolean): void {
  if (text === null) {
    el.replaceChildren()
    const ph = document.createElement('span')
    ph.className = 'placeholder'
    ph.textContent = '—'
    el.appendChild(ph)
    el.classList.remove('is-error')
  } else {
    el.textContent = text
    el.classList.toggle('is-error', !ok)
  }
}

function renderError(el: HTMLPreElement, message: string, loc: { line: number; col: number } | null): void {
  el.replaceChildren()
  el.classList.add('is-error')

  const prefixMatch = message.match(/^([A-Z][a-zA-Z]*\s?[Ee]rror):\s*(.+)$/s)
  if (prefixMatch) {
    const strong = document.createElement('strong')
    strong.textContent = prefixMatch[1] + ':'
    el.appendChild(strong)
    el.appendChild(document.createTextNode(' ' + prefixMatch[2]))
  } else {
    el.appendChild(document.createTextNode(message))
  }

  if (loc) {
    el.appendChild(document.createTextNode('\n'))
    const locEl = document.createElement('span')
    locEl.className = 'error-location'
    locEl.dataset.testid = 'error-location'
    locEl.textContent = `Ln ${loc.line}, Col ${loc.col}`
    el.appendChild(locEl)
  }
}
