/// <reference lib="webworker" />
// Persistent Web Worker that owns ONE `Xpr` instance for its lifetime
// (Locked Decision #9: persist the JS runtime; do NOT terminate per eval).
//
// Wire protocol with `JsWorkerRuntime` (see js-worker.ts):
//   main -> worker:  { id, expr, ctx }       evaluate request
//                    { ping: true, id }      liveness probe
//   worker -> main:  { id, success, value?, error?, durationMs }
//                    { id, pong: true }
// The `id` round-trips so the adapter can match responses to its pending map
// even if a later message overtakes an earlier one.

import { Xpr, XprError } from '@xpr-lang/xpr'

interface EvalRequest {
  id: number
  expr: string
  ctx: Record<string, unknown>
}

interface PingRequest {
  id: number
  ping: true
}

type IncomingMessage = EvalRequest | PingRequest

const xpr = new Xpr()

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data

  if ('ping' in msg) {
    self.postMessage({ id: msg.id, pong: true })
    return
  }

  const { id, expr, ctx } = msg
  const start = performance.now()
  try {
    const value = xpr.evaluate(expr, ctx)
    const durationMs = performance.now() - start
    try {
      self.postMessage({ id, success: true, value, durationMs })
    } catch (postErr) {
      // Result wasn't structured-cloneable (e.g. a function). Surface it as
      // an error rather than letting postMessage throw past the handler and
      // kill the worker.
      self.postMessage({
        id,
        success: false,
        error: { message: `Result is not transferable: ${String(postErr)}` },
        durationMs,
      })
    }
  } catch (err) {
    const durationMs = performance.now() - start
    // Mirror JsDirectRuntime's boundary: collapse xpr-js's -1 "no position"
    // sentinel to `undefined` so downstream UI branches on `position !== undefined`.
    const error =
      err instanceof XprError && err.position >= 0
        ? { message: err.message, position: err.position }
        : { message: err instanceof Error ? err.message : String(err) }
    self.postMessage({ id, success: false, error, durationMs })
  }
}
