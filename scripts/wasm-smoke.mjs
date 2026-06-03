#!/usr/bin/env node
/**
 * wasm-smoke.mjs — verifies the vendored xpr-go.wasm runtime.
 *
 * Phase 1: instantiate the WASM module via wasm_exec.js, then call
 *   globalThis.xprGoEvaluate("1 + 2", "{}")
 * and assert the canonical envelope shape.
 *
 * Phase 2: iterate over every example defined in `src/main.ts` (EXAMPLES
 * constant) and confirm the Go runtime evaluates each one without
 * crashing. Outputs are captured to a parity JSON file for the
 * orchestrator's evidence trail.
 *
 * Usage:
 *   node scripts/wasm-smoke.mjs
 *   node scripts/wasm-smoke.mjs --evidence /path/to/output.json
 *
 * Exit codes:
 *   0  - basic eval matched expected output and every example produced
 *        a response (errors from xpr itself are acceptable, crashes are not)
 *   1  - basic eval failed or the runtime crashed mid-iteration
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const playgroundRoot = resolve(__dirname, '..')

const WASM_PATH = resolve(playgroundRoot, 'public/xpr-go.wasm')
const WASM_EXEC_PATH = resolve(playgroundRoot, 'public/wasm_exec.js')
const MAIN_TS_PATH = resolve(playgroundRoot, 'src/main.ts')

const args = process.argv.slice(2)
const evidenceIdx = args.indexOf('--evidence')
const EVIDENCE_PATH =
  evidenceIdx >= 0 && args[evidenceIdx + 1]
    ? resolve(args[evidenceIdx + 1])
    : resolve(playgroundRoot, '../.sisyphus/evidence/playground-v2/W0-3-wasm-parity.json')

/** Extract the EXAMPLES literal from main.ts and evaluate it in a sandboxed scope. */
function loadExamples() {
  const source = readFileSync(MAIN_TS_PATH, 'utf8')
  const match = source.match(
    /const EXAMPLES[^=]*=\s*(\{[\s\S]*?^\})\s*\n/m
  )
  if (!match) throw new Error('Could not locate EXAMPLES literal in src/main.ts')
  // The literal uses JSON.stringify(...) which is fine — JSON is a global in any V8 context.
  // eslint-disable-next-line no-new-func
  const factory = new Function(`return (${match[1]})`)
  return factory()
}

/** Boot the Go WASM runtime; resolves once xprGoEvaluate is callable. */
async function bootRuntime() {
  // wasm_exec.js installs `Go` on the global scope when evaluated.
  const glue = readFileSync(WASM_EXEC_PATH, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function(glue).call(globalThis)
  if (typeof globalThis.Go !== 'function') {
    throw new Error('wasm_exec.js did not install globalThis.Go')
  }

  const go = new globalThis.Go()
  const bytes = readFileSync(WASM_PATH)
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject)

  // go.run() resolves only when the Go main goroutine exits. Our shim
  // blocks on a channel forever to keep xprGoEvaluate alive, so we
  // deliberately do NOT await this promise.
  go.run(instance).catch((err) => {
    console.error('Go runtime exited unexpectedly:', err)
    process.exit(2)
  })

  // js.Global().Set("xprGoEvaluate", ...) runs synchronously before the
  // channel block, so by the time go.run() returns control to the JS
  // event loop the function is already registered. One microtask is
  // sufficient; we add a small grace period for paranoia.
  for (let i = 0; i < 50; i++) {
    if (typeof globalThis.xprGoEvaluate === 'function') return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('xprGoEvaluate was never registered on globalThis')
}

function evalOnce(expr, ctx) {
  const t0 = performance.now()
  let raw, parsed, status
  try {
    raw = globalThis.xprGoEvaluate(expr, ctx)
    parsed = JSON.parse(raw)
    status = 'error' in parsed ? 'xpr_error' : 'ok'
  } catch (err) {
    return {
      status: 'crash',
      elapsedMs: +(performance.now() - t0).toFixed(3),
      crash: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    status,
    elapsedMs: +(performance.now() - t0).toFixed(3),
    raw,
    parsed,
  }
}

async function main() {
  console.log('xpr-go WASM smoke')
  console.log(`  wasm:      ${WASM_PATH}`)
  console.log(`  wasm_exec: ${WASM_EXEC_PATH}`)
  console.log(`  evidence:  ${EVIDENCE_PATH}`)
  console.log('')

  await bootRuntime()
  console.log('boot ok: globalThis.xprGoEvaluate is registered')

  // ---- Phase 1: basic eval ----
  const basic = evalOnce('1 + 2', '{}')
  console.log(`basic(1 + 2) -> ${basic.raw}`)
  if (basic.status !== 'ok' || basic.parsed.result !== '3') {
    console.error('FAIL: basic eval did not return {"result":"3"}')
    process.exit(1)
  }

  // ---- Phase 2: 16-example parity ----
  const EXAMPLES = loadExamples()
  const keys = Object.keys(EXAMPLES)
  console.log(`parity: iterating ${keys.length} examples from src/main.ts`)

  const results = []
  for (const key of keys) {
    const { expr, ctx } = EXAMPLES[key]
    const r = evalOnce(expr, ctx)
    results.push({ key, expr, ctx, ...r })
    const tag =
      r.status === 'ok' ? 'ok   ' : r.status === 'xpr_error' ? 'xpr_err' : 'CRASH'
    const detail =
      r.status === 'ok'
        ? r.parsed.result
        : r.status === 'xpr_error'
          ? r.parsed.error
          : r.crash
    const truncated = detail && detail.length > 80 ? detail.slice(0, 77) + '...' : detail
    console.log(`  [${tag}] ${key.padEnd(28)} ${truncated}`)
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    xpr_error: results.filter((r) => r.status === 'xpr_error').length,
    crash: results.filter((r) => r.status === 'crash').length,
  }

  const evidence = {
    schema: 'W0-3-wasm-parity-v1',
    generated_at: new Date().toISOString(),
    wasm_path: WASM_PATH,
    wasm_size_bytes: readFileSync(WASM_PATH).byteLength,
    wasm_exec_path: WASM_EXEC_PATH,
    basic_eval: basic,
    summary,
    results,
  }

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')

  console.log('')
  console.log(`summary: ${summary.ok} ok, ${summary.xpr_error} xpr_error, ${summary.crash} crash`)
  console.log(`evidence written -> ${EVIDENCE_PATH}`)

  if (summary.crash > 0) {
    console.error(`FAIL: ${summary.crash} example(s) crashed the runtime`)
    process.exit(1)
  }

  // Stop the still-running Go runtime by exiting the Node process.
  process.exit(0)
}

main().catch((err) => {
  console.error('smoke failed:', err)
  process.exit(1)
})
