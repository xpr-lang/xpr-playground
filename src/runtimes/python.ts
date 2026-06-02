// Python runtime adapter (W3.3). Off-loads XPR evaluation to a Pyodide-backed Web
// Worker (python.worker.ts). It mirrors js-worker.ts's worker-management pattern
// (Worker-from-URL, message correlation, per-eval timeout, teardown) but with the
// opposite lifecycle: Locked Decision #9 makes Python terminate-per-eval, because
// each eval can grow Pyodide's multi-MB heap and discarding the worker is the only
// reliable way to reclaim it.
//
// Each evaluate() first prime()s a worker (spawn + `init`, 30s budget) so Pyodide
// boots and the wheel installs on a worker that is ready before any expression
// runs; then runEval() sends `eval` to that booted worker (5s budget) and
// terminates it regardless of outcome. Splitting boot from eval keeps a cold WASM
// compile from tripping the eval timeout. Evaluations are serialised so the single
// primed worker is never raced.

import type { EvaluationResult, RuntimeAdapter } from './types'

const INIT_TIMEOUT_MS = 30_000
const EVAL_TIMEOUT_MS = 5_000

interface ProgressMessage {
  type: 'progress'
  value: number
}
interface ReadyMessage {
  type: 'ready'
}
interface InitErrorMessage {
  type: 'error'
  message: string
}
interface ResultMessage {
  type: 'result'
  id: number
  success: boolean
  value?: unknown
  error?: { message: string }
  durationMs: number
}
type WorkerOutbound = ProgressMessage | ReadyMessage | InitErrorMessage | ResultMessage

export class PythonRuntime implements RuntimeAdapter {
  readonly name = 'python' as const
  readonly displayName = 'Python'

  // Stays true once the first boot succeeds (the browser keeps the compiled WASM
  // cached), so the UI sees a stable "available" runtime across the per-eval churn.
  private ready = false
  // A booted worker awaiting its one eval: created by prime(), consumed by runEval().
  private primedWorker: Worker | null = null
  // De-dupes concurrent prime() calls; abort() lets terminate() cancel an in-flight boot.
  private priming: { promise: Promise<void>; abort: (err: Error) => void } | null = null
  // The worker running the current eval and how to settle it, so terminate() can
  // kill it and resolve the caller instead of leaving a dangling promise.
  private activeEval: { worker: Worker; settle: (result: EvaluationResult) => void } | null = null
  // Serialises evaluate(): one primed worker can serve only one eval.
  private evalChain: Promise<void> = Promise.resolve()
  private nextId = 0

  isReady(): boolean {
    return this.ready
  }

  initialize(onProgress?: (p: number) => void): Promise<void> {
    return this.prime(onProgress)
  }

  evaluate(expr: string, ctx: Record<string, unknown>): Promise<EvaluationResult> {
    const run = this.evalChain.then(() => this.runEval(expr, ctx))
    this.evalChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  terminate(): void {
    if (this.priming !== null) this.priming.abort(new Error('Python runtime terminated'))
    if (this.activeEval !== null) {
      this.activeEval.settle({
        runtime: this.name,
        success: false,
        error: { message: 'Python runtime terminated' },
        durationMs: 0,
      })
    }
    if (this.primedWorker !== null) {
      this.primedWorker.terminate()
      this.primedWorker = null
    }
    this.ready = false
  }

  private spawnWorker(): Worker {
    return new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module' })
  }

  private prime(onProgress?: (p: number) => void): Promise<void> {
    if (this.primedWorker !== null) {
      onProgress?.(100)
      return Promise.resolve()
    }
    if (this.priming !== null) return this.priming.promise

    let abort!: (err: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      const worker = this.spawnWorker()
      let done = false
      const finish = (cleanup: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.priming = null
        cleanup()
      }
      const timer = setTimeout(() => {
        finish(() => {
          worker.terminate()
          reject(new Error(`Python runtime initialization timed out (${INIT_TIMEOUT_MS / 1000}s)`))
        })
      }, INIT_TIMEOUT_MS)

      abort = (err: Error): void =>
        finish(() => {
          worker.terminate()
          reject(err)
        })

      worker.onmessage = (event: MessageEvent<WorkerOutbound>): void => {
        const msg = event.data
        if (msg.type === 'progress') {
          onProgress?.(clampProgress(msg.value))
        } else if (msg.type === 'ready') {
          finish(() => {
            this.primedWorker = worker
            this.ready = true
            onProgress?.(100)
            resolve()
          })
        } else if (msg.type === 'error') {
          finish(() => {
            worker.terminate()
            reject(new Error(msg.message))
          })
        }
      }
      worker.onerror = (): void =>
        finish(() => {
          worker.terminate()
          reject(new Error('Python worker crashed during initialization'))
        })

      onProgress?.(0)
      worker.postMessage({ type: 'init' })
    })
    this.priming = { promise, abort }
    return promise
  }

  private async runEval(expr: string, ctx: Record<string, unknown>): Promise<EvaluationResult> {
    const t0 = performance.now()
    try {
      await this.prime()
    } catch (err) {
      return {
        runtime: this.name,
        success: false,
        error: { message: `Failed to initialize Python runtime: ${err instanceof Error ? err.message : String(err)}` },
        durationMs: performance.now() - t0,
      }
    }

    const worker = this.primedWorker
    if (worker === null) {
      return {
        runtime: this.name,
        success: false,
        error: { message: 'Python runtime is not ready' },
        durationMs: performance.now() - t0,
      }
    }
    this.primedWorker = null
    const id = this.nextId++

    return new Promise<EvaluationResult>((resolve) => {
      let settled = false
      const settle = (result: EvaluationResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.terminate()
        if (this.activeEval?.worker === worker) this.activeEval = null
        resolve(result)
      }
      const timer = setTimeout(() => {
        settle({
          runtime: this.name,
          success: false,
          error: { message: `Evaluation timed out (${EVAL_TIMEOUT_MS / 1000}s)` },
          durationMs: performance.now() - t0,
        })
      }, EVAL_TIMEOUT_MS)

      this.activeEval = { worker, settle }

      worker.onmessage = (event: MessageEvent<WorkerOutbound>): void => {
        const msg = event.data
        if (msg.type !== 'result' || msg.id !== id) return
        settle({
          runtime: this.name,
          success: msg.success,
          value: msg.value,
          error: msg.error,
          durationMs: msg.durationMs,
        })
      }
      worker.onerror = (): void => {
        settle({
          runtime: this.name,
          success: false,
          error: { message: 'Python worker crashed during evaluation' },
          durationMs: performance.now() - t0,
        })
      }

      worker.postMessage({ type: 'eval', id, expr, ctx })
    })
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}
