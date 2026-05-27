// JS adapter that off-loads `xpr.evaluate` to a persistent Web Worker
// (W2.5). Pathological expressions therefore stall ONLY the worker, never
// the main thread, so the editor, theme toggle, and CodeMirror keep
// responding while a slow eval runs. Locked Decision #9: the worker is
// reused across calls; we only terminate on timeout / hard error / explicit
// `terminate()` / iOS Safari background-tab recovery.
//
// Vite recognises the exact `new Worker(new URL('./js.worker.ts', import.meta.url), { type: 'module' })`
// form and emits the worker as its own module chunk, with its `@xpr-lang/xpr`
// import bundled inside that chunk (no main-thread duplication).

import type { EvaluationResult, RuntimeAdapter } from './types'

const EVAL_TIMEOUT_MS = 5_000
const VISIBILITY_PING_TIMEOUT_MS = 1_000

interface WorkerEvalResponse {
  id: number
  success: boolean
  value?: unknown
  error?: { message: string; position?: number }
  durationMs: number
}

interface WorkerPongResponse {
  id: number
  pong: true
}

type WorkerResponse = WorkerEvalResponse | WorkerPongResponse

interface PendingEval {
  resolve: (result: EvaluationResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPing {
  resolve: () => void
  reject: () => void
  timer: ReturnType<typeof setTimeout>
}

export class JsWorkerRuntime implements RuntimeAdapter {
  readonly name = 'js' as const
  readonly displayName = 'JavaScript'

  private worker: Worker | null = null
  private nextId = 0
  private readonly pendingEvals = new Map<number, PendingEval>()
  private readonly pendingPings = new Map<number, PendingPing>()

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
  }

  isReady(): boolean {
    return true
  }

  initialize(): Promise<void> {
    this.ensureWorker()
    return Promise.resolve()
  }

  evaluate(expr: string, ctx: Record<string, unknown>): Promise<EvaluationResult> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<EvaluationResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingEvals.delete(id)) return
        // Pathological loop in the worker. Kill it so the next evaluate gets
        // a fresh context. recreateWorker below also drops any other in-flight
        // evals, so capture the timeout outcome BEFORE that runs.
        this.recreateWorker('Evaluation timed out')
        resolve({
          runtime: this.name,
          success: false,
          error: { message: `Evaluation timed out (${EVAL_TIMEOUT_MS / 1000}s)` },
          durationMs: EVAL_TIMEOUT_MS,
        })
      }, EVAL_TIMEOUT_MS)
      this.pendingEvals.set(id, { resolve, timer })
      worker.postMessage({ id, expr, ctx })
    })
  }

  terminate(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.recreateWorker('Worker terminated')
  }

  private ensureWorker(): Worker {
    if (this.worker === null) this.worker = this.spawnWorker()
    return this.worker
  }

  private spawnWorker(): Worker {
    const worker = new Worker(new URL('./js.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data)
    worker.onerror = () => this.recreateWorker('Worker crashed')
    worker.onmessageerror = () => this.recreateWorker('Worker message could not be deserialized')
    return worker
  }

  private recreateWorker(reason: string): void {
    if (this.worker !== null) {
      this.worker.terminate()
      this.worker = null
    }
    for (const { resolve, timer } of this.pendingEvals.values()) {
      clearTimeout(timer)
      resolve({
        runtime: this.name,
        success: false,
        error: { message: reason },
        durationMs: 0,
      })
    }
    this.pendingEvals.clear()
    for (const { reject, timer } of this.pendingPings.values()) {
      clearTimeout(timer)
      reject()
    }
    this.pendingPings.clear()
  }

  private onMessage(msg: WorkerResponse): void {
    if ('pong' in msg) {
      const pending = this.pendingPings.get(msg.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pendingPings.delete(msg.id)
      pending.resolve()
      return
    }
    const pending = this.pendingEvals.get(msg.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingEvals.delete(msg.id)
    pending.resolve({
      runtime: this.name,
      success: msg.success,
      value: msg.value,
      error: msg.error,
      durationMs: msg.durationMs,
    })
  }

  // Locked Decision #25: iOS Safari aggressively reclaims worker memory while
  // tabs are backgrounded, so when the user comes back we probe with a ping;
  // an unresponsive worker is dead and gets recreated lazily on the next eval.
  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return
    if (document.visibilityState !== 'visible') return
    if (this.worker === null) return
    this.ping().catch(() => this.recreateWorker('Worker unresponsive after tab resume'))
  }

  private ping(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.worker === null) {
        resolve()
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pendingPings.delete(id)) reject()
      }, VISIBILITY_PING_TIMEOUT_MS)
      this.pendingPings.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, ping: true })
    })
  }
}
