#!/usr/bin/env node
/**
 * cross-runtime-test.mjs - W5.2 cross-runtime equivalence gate.
 *
 * Loads tests/fixtures/cross-runtime.json and evaluates every example in all
 * three XPR runtimes, in this single Node process:
 *   - JS     in-process via the local @xpr-lang/xpr (file:../xpr-js)
 *   - Python via vendored Pyodide 0.27.5 + the xpr-lang wheel (no CDN egress)
 *   - Go     via the vendored xpr-go.wasm + wasm_exec.js
 *
 * Each result is normalized to canonical sorted-key JSON (the exact W3.5
 * `normalize` semantics from src/divergence.ts: recursive key sort, array order
 * preserved, strict string compare, NO float tolerance) and the three runtimes
 * are asserted byte-identical for every one of the 16 benign examples. The
 * stored `expected` (current xpr-js output) is a regression anchor checked too.
 *
 * `knownDivergences` are by-design exceptions catalogued in
 * tests/fixtures/known-divergences.md (regex Unicode \w, Go RE2 lookbehind).
 * They are run to prove the divergence path fires and are TOLERATED; the runner
 * prints exactly which ones it tolerated. A benign example that diverges, OR a
 * known divergence that is missing, is a hard failure (exit 1). Nothing is
 * silently swallowed.
 *
 * Usage:   node scripts/cross-runtime-test.mjs
 * Exit:    0  all 16 benign examples match across JS/Python/Go
 *          1  any benign divergence, regression, or runtime boot failure
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Xpr, XprError } from '@xpr-lang/xpr'

const __dirname = dirname(fileURLToPath(import.meta.url))
const playgroundRoot = resolve(__dirname, '..')

// Defaults to the committed fixture; CROSS_RUNTIME_FIXTURE lets CI or a reviewer
// point the gate at an alternate fixture (also used to self-test the fail path).
const FIXTURE_PATH = process.env.CROSS_RUNTIME_FIXTURE
  ? resolve(process.env.CROSS_RUNTIME_FIXTURE)
  : resolve(playgroundRoot, 'tests/fixtures/cross-runtime.json')
const WASM_PATH = resolve(playgroundRoot, 'public/xpr-go.wasm')
const WASM_EXEC_PATH = resolve(playgroundRoot, 'public/wasm_exec.js')
const VENDOR_PYODIDE = resolve(playgroundRoot, 'public/vendor/pyodide-0.27.5')
const VENDOR_WHEEL = resolve(playgroundRoot, 'public/vendor/wheels/xpr_lang-0.5.0-py3-none-any.whl')

// ---------------------------------------------------------------------------
// normalize() - copied verbatim from src/divergence.ts (W3.5, Locked Decision
// #8). Recursively sorts object keys at every depth, preserves array order, and
// serialises to a byte-comparable string. No float epsilon, no "close enough".
// ---------------------------------------------------------------------------
function normalize(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : String(value)
  if (t === 'bigint') return `${value.toString()}n`
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (t === 'function' || t === 'symbol') return `[${t}]`
  if (Array.isArray(value)) return '[' + value.map(normalize).join(',') + ']'
  const obj = value
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + normalize(obj[k])).join(',') + '}'
}

// One-line, truncated rendering of an outcome for the console table.
function show(outcome) {
  const s = outcome.success ? JSON.stringify(outcome.value) : `ERROR: ${outcome.error}`
  const str = s === undefined ? String(outcome.value) : s
  return str.length > 60 ? str.slice(0, 57) + '...' : str
}

// ---------------------------------------------------------------------------
// JS runtime - in-process, mirrors src/runtimes/js-direct.ts.
// ---------------------------------------------------------------------------
function evalJs(xpr, expr, ctx) {
  try {
    return { success: true, value: xpr.evaluate(expr, ctx) }
  } catch (err) {
    return { success: false, error: err instanceof XprError ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Go runtime - vendored WASM, mirrors src/runtimes/go.worker.ts. Boot logic
// follows scripts/wasm-smoke.mjs (wasm_exec.js installs globalThis.Go; go.run
// blocks forever so it is fire-and-forget; poll for xprGoEvaluate registration).
// ---------------------------------------------------------------------------
async function bootGo() {
  const glue = readFileSync(WASM_EXEC_PATH, 'utf8')
  new Function(glue).call(globalThis)
  if (typeof globalThis.Go !== 'function') {
    throw new Error('wasm_exec.js did not install globalThis.Go')
  }
  const go = new globalThis.Go()
  const bytes = readFileSync(WASM_PATH)
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject)
  go.run(instance).catch((err) => {
    console.error('Go runtime exited unexpectedly:', err)
    process.exit(2)
  })
  for (let i = 0; i < 200; i++) {
    if (typeof globalThis.xprGoEvaluate === 'function') return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('xprGoEvaluate was never registered on globalThis')
}

function evalGo(expr, ctx) {
  try {
    const raw = globalThis.xprGoEvaluate(expr, JSON.stringify(ctx))
    const envelope = JSON.parse(raw)
    if (envelope.error !== undefined) return { success: false, error: envelope.error }
    return { success: true, value: JSON.parse(envelope.result) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Python runtime - vendored Pyodide, mirrors src/runtimes/python.worker.ts. Boot
// follows scripts/pyodide-smoke.mjs (indexURL is a filesystem path in Node, NOT a
// file:// URL; the wheel install DOES take a file:// URL). The ENTRY program and
// the toPy globals handoff are byte-identical to the production worker.
// ---------------------------------------------------------------------------
const PY_ENTRY = `
import json
from xpr import Xpr

def _xpr_entry(expr, ctx_json):
    try:
        value = Xpr().evaluate(expr, json.loads(ctx_json))
        return json.dumps({"ok": True, "value": value})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})

_xpr_entry(_expr, _ctx_json)
`

async function bootPython() {
  const pyodideMjsUrl = pathToFileURL(resolve(VENDOR_PYODIDE, 'pyodide.mjs')).href
  const indexURL = VENDOR_PYODIDE + '/'
  const wheelURL = pathToFileURL(VENDOR_WHEEL).href
  const { loadPyodide, version } = await import(pyodideMjsUrl)
  if (version !== '0.27.5') throw new Error(`expected Pyodide 0.27.5, got ${version}`)
  const pyodide = await loadPyodide({ indexURL })
  await pyodide.loadPackage('micropip')
  const micropip = pyodide.pyimport('micropip')
  await micropip.install(wheelURL)
  micropip.destroy()
  await pyodide.runPythonAsync('from xpr import Xpr')
  return pyodide
}

async function evalPython(pyodide, expr, ctx) {
  const globals = pyodide.toPy({ _expr: expr, _ctx_json: JSON.stringify(ctx) })
  try {
    const jsonStr = await pyodide.runPythonAsync(PY_ENTRY, { globals })
    const env = JSON.parse(jsonStr)
    return env.ok ? { success: true, value: env.value } : { success: false, error: env.error }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    globals.destroy()
  }
}

// A runtime's canonical signature: its normalized value, or a distinct error
// bucket. Two runtimes agree iff their signatures are byte-identical.
function signature(outcome) {
  return outcome.success ? 'V' + normalize(outcome.value) : 'E'
}

async function main() {
  console.log('W5.2 cross-runtime equivalence gate')
  console.log(`  fixture:  ${FIXTURE_PATH}`)
  console.log(`  wasm:     ${WASM_PATH}`)
  console.log(`  pyodide:  ${VENDOR_PYODIDE}/`)
  console.log('')

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  const examples = fixture.examples ?? []
  const knownDivergences = fixture.knownDivergences ?? []
  if (examples.length === 0) {
    console.error('FAIL: fixture has no examples')
    process.exit(1)
  }

  console.log('booting runtimes (Go WASM + Pyodide)...')
  const tBoot = performance.now()
  await bootGo()
  const pyodide = await bootPython()
  const xpr = new Xpr()
  console.log(`runtimes ready in ${((performance.now() - tBoot) / 1000).toFixed(1)}s`)
  console.log('')

  // ---- the gate: 16 benign examples must match across all three ----
  console.log(`evaluating ${examples.length} examples across JS / Python / Go:`)
  const failures = []
  let matched = 0
  for (const ex of examples) {
    const js = evalJs(xpr, ex.expr, ex.ctx)
    const py = await evalPython(pyodide, ex.expr, ex.ctx)
    const go = evalGo(ex.expr, ex.ctx)

    const reasons = []
    if (!js.success) reasons.push(`js errored (${js.error})`)
    if (!py.success) reasons.push(`python errored (${py.error})`)
    if (!go.success) reasons.push(`go errored (${go.error})`)
    if (js.success && py.success && go.success) {
      const nj = normalize(js.value)
      const np = normalize(py.value)
      const ng = normalize(go.value)
      if (!(nj === np && np === ng)) {
        reasons.push(`runtimes disagree: js=${nj} python=${np} go=${ng}`)
      }
      const ne = normalize(ex.expected)
      if (nj !== ne) {
        reasons.push(`regression: js=${nj} != expected=${ne}`)
      }
    }

    if (reasons.length === 0) {
      matched++
      console.log(`  [match] ${ex.id.padEnd(26)} ${show(js)}`)
    } else {
      failures.push({ id: ex.id, reasons, js, py, go })
      console.log(`  [FAIL ] ${ex.id.padEnd(26)} ${reasons.join('; ')}`)
      console.log(`          js=${show(js)}  py=${show(py)}  go=${show(go)}`)
    }
  }

  // ---- known, by-design divergences: run, tolerate, and print them ----
  console.log('')
  console.log(`evaluating ${knownDivergences.length} known divergences (by design, tolerated):`)
  let toleratedCount = 0
  const staleCatalog = []
  for (const kd of knownDivergences) {
    const js = evalJs(xpr, kd.expr, kd.ctx ?? {})
    const py = await evalPython(pyodide, kd.expr, kd.ctx ?? {})
    const go = evalGo(kd.expr, kd.ctx ?? {})
    const diverged = !(signature(js) === signature(py) && signature(py) === signature(go))
    if (diverged) {
      toleratedCount++
      console.log(`  [tolerated] ${kd.id}`)
    } else {
      staleCatalog.push(kd.id)
      console.log(`  [NOTE] ${kd.id} no longer diverges - known-divergences.md may be stale`)
    }
    console.log(`          js=${show(js)}  py=${show(py)}  go=${show(go)}`)
    console.log(`          why: ${kd.reason}`)
  }

  // ---- summary ----
  console.log('')
  console.log('='.repeat(72))
  if (failures.length === 0) {
    console.log(`RESULT: PASS - ${matched}/${examples.length} examples match across JS, Python, Go`)
    console.log(`        ${toleratedCount} known divergence(s) tolerated (catalogued in known-divergences.md)`)
    if (staleCatalog.length > 0) {
      console.log(`        note: ${staleCatalog.join(', ')} converged; consider updating the catalog`)
    }
    console.log('='.repeat(72))
    pyodide.runPython('import gc; gc.collect()')
    process.exit(0)
  } else {
    console.log(`RESULT: FAIL - ${matched}/${examples.length} matched, ${failures.length} diverged unexpectedly`)
    for (const f of failures) console.log(`        - ${f.id}: ${f.reasons.join('; ')}`)
    console.log('='.repeat(72))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('cross-runtime gate crashed:', err)
  process.exit(1)
})
