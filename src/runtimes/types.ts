// Public API contract every XPR runtime implements (JS direct, JS worker,
// Python via Pyodide, Go via WASM). `evaluate` is async so future
// worker-backed adapters share the same call site as the sync JS one.

export type RuntimeName = 'js' | 'python' | 'go'

export interface EvaluationResult {
  runtime: RuntimeName
  success: boolean
  value?: unknown
  error?: {
    message: string
    // Flat 0-based char offset, mirrors `XprError.position` from xpr-js.
    // Omitted when xpr-js returns its -1 sentinel so downstream lint can
    // branch on `position !== undefined`.
    position?: number
  }
  durationMs: number
}

export interface RuntimeAdapter {
  readonly name: RuntimeName
  readonly displayName: string
  isReady(): boolean
  initialize(onProgress?: (p: number) => void): Promise<void>
  evaluate(expr: string, ctx: Record<string, unknown>): Promise<EvaluationResult>
  terminate(): void
}
