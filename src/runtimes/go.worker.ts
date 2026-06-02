/// <reference lib="webworker" />
// Go WASM evaluator worker. GoRuntime (go.ts) treats this worker as one-shot
// per Locked Decision #9: it terminates and re-warms after each eval so the
// multi-MB Go heap is reclaimed rather than kept warm like the JS worker.
//
// Wire protocol with GoRuntime:
//   main -> worker:  { id, expr, ctx }                         evaluate request
//   worker -> main:  { phase: 'instantiating' | 'ready' }      progress (no id)
//                    { phase: 'error', message }               init failed
//                    { id, success, value?, error?, durationMs }   result
//
// importScripts() is unavailable in a { type:'module' } worker and eval() needs
// CSP 'unsafe-eval' (forbidden, Locked Decision #24), so we SIDE-EFFECT import
// the vendored classic-IIFE wasm_exec.js to install `Go`. The 4.7MB xpr-go.wasm
// stays in public/ and is fetched by absolute URL; Vite's ?init helper would
// omit go.importObject and break the gojs host imports.
import './wasm_exec.js'

const WASM_URL = '/xpr-go.wasm'

interface EvalRequest {
  id: number
  expr: string
  ctx: Record<string, unknown>
}

interface EvalResponse {
  id: number
  success: boolean
  value?: unknown
  error?: { message: string }
  durationMs: number
}

const ready: Promise<void> = (async () => {
  self.postMessage({ phase: 'instantiating' })
  const go = new Go()
  let source: WebAssembly.WebAssemblyInstantiatedSource
  try {
    source = await WebAssembly.instantiateStreaming(fetch(WASM_URL), go.importObject)
  } catch {
    // instantiateStreaming rejects on a wrong/absent Content-Type (notably
    // Safari and some static hosts); fall back to the buffered path.
    const bytes = await (await fetch(WASM_URL)).arrayBuffer()
    source = await WebAssembly.instantiate(bytes, go.importObject)
  }
  // Fire-and-forget (block body, NOT `=> go.run(...)`): go.run resolves only
  // when Go main() exits, but the shim blocks forever to stay callable, so its
  // promise never resolves. Returning it would hang `ready` permanently.
  go.run(source.instance)
  // xprGoEvaluate is registered synchronously as Go main runs up to its channel
  // block; poll briefly to stay robust against any internal await in go.run().
  for (let i = 0; i < 200; i++) {
    if (typeof xprGoEvaluate === 'function') return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error('xprGoEvaluate was not registered after go.run()')
})()

ready.then(
  () => {
    self.postMessage({ phase: 'ready' })
  },
  (err: unknown) => {
    self.postMessage({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
  },
)

self.onmessage = (event: MessageEvent<EvalRequest>) => {
  const { id, expr, ctx } = event.data
  const start = performance.now()
  ready.then(
    () => {
      let response: EvalResponse
      try {
        const raw = xprGoEvaluate(expr, JSON.stringify(ctx))
        const envelope = JSON.parse(raw) as { result?: string; error?: string }
        const durationMs = performance.now() - start
        response =
          envelope.error !== undefined
            ? { id, success: false, error: { message: envelope.error }, durationMs }
            : { id, success: true, value: JSON.parse(envelope.result as string), durationMs }
      } catch (err) {
        // An unrecovered Go panic surfaces as a thrown JS error (not an
        // envelope), as does any malformed envelope; collapse both to a result.
        response = {
          id,
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
          durationMs: performance.now() - start,
        }
      }
      self.postMessage(response)
    },
    (err: unknown) => {
      self.postMessage({
        id,
        success: false,
        error: { message: err instanceof Error ? err.message : String(err) },
        durationMs: performance.now() - start,
      } satisfies EvalResponse)
    },
  )
}
