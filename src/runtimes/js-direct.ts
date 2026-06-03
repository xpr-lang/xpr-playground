// JS adapter that runs on the main thread (W2.4 baseline; W2.5 upgrades to a Worker).
// Locked Decision #9: persist the JS runtime across evaluations, so `terminate()`
// is a no-op and the `Xpr` instance is reused.

import { Xpr, XprError } from '@xpr-lang/xpr'
import type { EvaluationResult, RuntimeAdapter } from './types'

export class JsDirectRuntime implements RuntimeAdapter {
  readonly name = 'js' as const
  readonly displayName = 'JavaScript'

  private xpr: Xpr | null = null

  isReady(): boolean {
    return true
  }

  initialize(): Promise<void> {
    return Promise.resolve()
  }

  async evaluate(expr: string, ctx: Record<string, unknown>): Promise<EvaluationResult> {
    if (this.xpr === null) this.xpr = new Xpr()
    const t0 = performance.now()
    try {
      const value = this.xpr.evaluate(expr, ctx)
      return {
        runtime: this.name,
        success: true,
        value,
        durationMs: performance.now() - t0,
      }
    } catch (err) {
      const durationMs = performance.now() - t0
      const message = err instanceof XprError ? err.message : String(err)
      // Collapse xpr-js's -1 "no position" sentinel to `undefined` at the
      // adapter boundary so the UI lint branch is `position !== undefined`.
      const error: NonNullable<EvaluationResult['error']> =
        err instanceof XprError && err.position >= 0
          ? { message, position: err.position }
          : { message }
      return {
        runtime: this.name,
        success: false,
        error,
        durationMs,
      }
    }
  }

  terminate(): void {}
}
