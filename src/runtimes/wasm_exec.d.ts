// Ambient globals installed by the vendored classic-IIFE `wasm_exec.js` (Go
// 1.24+ glue) and the W0.3 Go shim. Global script (no import/export) so these
// `declare`s augment every module without per-call-site `@ts-ignore`.

declare class Go {
  importObject: WebAssembly.Imports
  // Resolves ONLY when Go main() exits; the shim blocks forever to keep
  // xprGoEvaluate callable, so this promise never resolves. Never await it.
  run(instance: WebAssembly.Instance): Promise<void>
}

// Returns a JSON envelope: `{"result":"<JSON value>"}` (result is itself a JSON
// string, parse twice) on success, or `{"error":"<message>"}` on failure.
declare function xprGoEvaluate(expr: string, contextJSON: string): string
