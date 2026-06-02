// Go adapter: evaluates XPR via the vendored Go WASM in a Web Worker.
//
// Locked Decision #9 (UNLIKE the persistent JS worker): the Go WASM heap grows
// and is never returned to the OS, so this runs a TERMINATE-PER-EVAL lifecycle.
// One warm worker is kept so isReady() is true and the next eval is fast; after
// each eval the worker is terminated and a fresh one warmed in the background,
// bounding memory to a single freshly-instantiated Go heap.
//
// Vite emits the worker (and its wasm_exec.js glue) as its own chunk only for
// the exact `new Worker(new URL('./go.worker.ts', import.meta.url), ...)` form.

import type { EvaluationResult, RuntimeAdapter } from './types'

const EVAL_TIMEOUT_MS = 10_000

type WorkerMessage =
  | { phase: 'instantiating' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string }
  | {
      id: number
      success: boolean
      value?: unknown
      error?: { message: string }
      durationMs: number
    }

interface PendingEval {
  resolve: (result: EvaluationResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerHandle {
  worker: Worker
  ready: Promise<void>
}

export class GoRuntime implements RuntimeAdapter {
  readonly name = 'go' as const
  readonly displayName = 'Go'

  private handle: WorkerHandle | null = null
  private warm = false
  private nextId = 0
  private readonly pendingEvals = new Map<number, PendingEval>()

  isReady(): boolean {
    return this.warm
  }

  async initialize(onProgress?: (p: number) => void): Promise<void> {
    onProgress?.(0)
    const handle = this.ensureWorker(onProgress)
    await handle.ready
    onProgress?.(100)
  }

  evaluate(expr: string, ctx: Record<string, unknown>): Promise<EvaluationResult> {
    const handle = this.ensureWorker()
    const id = this.nextId++
    return new Promise<EvaluationResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingEvals.delete(id)) return
        this.killWorker()
        this.failPending('Worker terminated (a sibling evaluation timed out)')
        this.warmUp()
        resolve({
          runtime: this.name,
          success: false,
          error: { message: `Evaluation timed out (${EVAL_TIMEOUT_MS / 1000}s)` },
          durationMs: EVAL_TIMEOUT_MS,
        })
      }, EVAL_TIMEOUT_MS)
      this.pendingEvals.set(id, { resolve, timer })
      handle.ready.then(
        () => {
          if (this.pendingEvals.has(id)) handle.worker.postMessage({ id, expr, ctx })
        },
        () => {
          const pending = this.pendingEvals.get(id)
          if (pending !== undefined) {
            clearTimeout(pending.timer)
            this.pendingEvals.delete(id)
            pending.resolve({
              runtime: this.name,
              success: false,
              error: { message: 'Go runtime failed to initialize' },
              durationMs: 0,
            })
          }
          if (this.handle === handle) this.killWorker()
        },
      )
    })
  }

  terminate(): void {
    this.killWorker()
    this.failPending('Worker terminated')
  }

  private ensureWorker(onProgress?: (p: number) => void): WorkerHandle {
    if (this.handle === null) this.handle = this.spawnWorker(onProgress)
    return this.handle
  }

  private warmUp(): void {
    this.handle = this.spawnWorker()
    this.handle.ready.catch(() => {})
  }

  private killWorker(): void {
    if (this.handle !== null) {
      this.handle.worker.terminate()
      this.handle = null
    }
    this.warm = false
  }

  private failPending(reason: string): void {
    for (const { resolve, timer } of this.pendingEvals.values()) {
      clearTimeout(timer)
      resolve({ runtime: this.name, success: false, error: { message: reason }, durationMs: 0 })
    }
    this.pendingEvals.clear()
  }

  private spawnWorker(onProgress?: (p: number) => void): WorkerHandle {
    this.warm = false
    const worker = new Worker(new URL('./go.worker.ts', import.meta.url), { type: 'module' })
    let resolveReady!: () => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })
    const handle: WorkerHandle = { worker, ready }
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data
      if ('phase' in msg) {
        if (msg.phase === 'instantiating') {
          onProgress?.(50)
        } else if (msg.phase === 'ready') {
          if (this.handle === handle) this.warm = true
          onProgress?.(100)
          resolveReady()
        } else {
          rejectReady(new Error(msg.message))
        }
        return
      }
      this.onResult(msg)
    }
    worker.onerror = () => {
      rejectReady(new Error('Go worker crashed'))
      if (this.handle === handle) {
        this.killWorker()
        this.failPending('Go worker crashed')
        this.warmUp()
      }
    }
    worker.onmessageerror = () => {
      if (this.handle === handle) {
        this.killWorker()
        this.failPending('Go worker message could not be deserialized')
        this.warmUp()
      }
    }
    return handle
  }

  private onResult(msg: Extract<WorkerMessage, { id: number }>): void {
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
    if (this.pendingEvals.size === 0) {
      this.killWorker()
      this.warmUp()
    }
  }
}
