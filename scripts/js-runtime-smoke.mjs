#!/usr/bin/env node
// W2.4 smoke: drive every EXAMPLES entry through JsDirectRuntime and assert
// the `EvaluationResult` shape matches the contract (success, value, durationMs).
//
// Mirrors the wasm-smoke.mjs pattern (EXAMPLES extracted via regex + Function)
// so we never duplicate the fixture set.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const playgroundRoot = resolve(__dirname, '..')
const MAIN_TS_PATH = resolve(playgroundRoot, 'src/main.ts')

const args = process.argv.slice(2)
const evidenceIdx = args.indexOf('--evidence')
const EVIDENCE_PATH =
  evidenceIdx >= 0 && args[evidenceIdx + 1]
    ? resolve(args[evidenceIdx + 1])
    : resolve(playgroundRoot, '../.sisyphus/evidence/playground-v2/W2-4-js-runtime-parity.json')

function loadExamples() {
  const source = readFileSync(MAIN_TS_PATH, 'utf8')
  const match = source.match(/const EXAMPLES[^=]*=\s*(\{[\s\S]*?^\})\s*\n/m)
  if (!match) throw new Error('Could not locate EXAMPLES literal in src/main.ts')
  const factory = new Function(`return (${match[1]})`)
  return factory()
}

const { JsDirectRuntime } = await import(resolve(playgroundRoot, 'src/runtimes/js-direct.ts'))

async function main() {
  console.log('W2.4 JsDirectRuntime smoke')
  console.log(`  main.ts:  ${MAIN_TS_PATH}`)
  console.log(`  evidence: ${EVIDENCE_PATH}`)
  console.log('')

  const runtime = new JsDirectRuntime()
  console.log(`runtime: name=${runtime.name} displayName=${runtime.displayName} isReady=${runtime.isReady()}`)
  await runtime.initialize()
  console.log('initialize() resolved')

  // Sanity: contract probe.
  const basic = await runtime.evaluate('1 + 2', {})
  console.log(`basic(1 + 2) -> success=${basic.success} value=${JSON.stringify(basic.value)} duration=${basic.durationMs.toFixed(2)}ms`)
  if (!basic.success || basic.value !== 3 || basic.runtime !== 'js') {
    console.error('FAIL: contract probe (1+2) did not return success/value=3/runtime=js')
    process.exit(1)
  }

  // Negative path: structured error with position.
  const err = await runtime.evaluate('1 + ', {})
  console.log(`error path(1 + ) -> success=${err.success} message="${err.error?.message}" position=${err.error?.position}`)
  if (err.success || !err.error?.message) {
    console.error('FAIL: error path did not yield a structured error')
    process.exit(1)
  }

  // Phase 2: 16-example parity.
  const EXAMPLES = loadExamples()
  const keys = Object.keys(EXAMPLES)
  console.log(`parity: iterating ${keys.length} examples`)

  const results = []
  for (const key of keys) {
    const { expr, ctx: ctxRaw } = EXAMPLES[key]
    let ctx = {}
    if (ctxRaw && ctxRaw !== '{}') {
      try { ctx = JSON.parse(ctxRaw) } catch { /* ignore — eval will surface */ }
    }
    const r = await runtime.evaluate(expr, ctx)
    results.push({
      key,
      expr,
      ctx: ctxRaw,
      success: r.success,
      value: r.value,
      error: r.error,
      durationMs: +r.durationMs.toFixed(3),
    })
    const tag = r.success ? 'ok ' : 'ERR'
    const detail = r.success
      ? JSON.stringify(r.value)
      : `${r.error?.message}${r.error?.position !== undefined ? ` @${r.error.position}` : ''}`
    const truncated = detail && detail.length > 80 ? detail.slice(0, 77) + '...' : detail
    console.log(`  [${tag}] ${key.padEnd(28)} ${truncated}`)
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.success).length,
    error: results.filter((r) => !r.success).length,
  }

  const evidence = {
    schema: 'W2-4-js-runtime-parity-v1',
    generated_at: new Date().toISOString(),
    runtime: { name: runtime.name, displayName: runtime.displayName },
    contract_probe: {
      basic_1_plus_2: { success: basic.success, value: basic.value, durationMs: +basic.durationMs.toFixed(3) },
      error_path: { success: err.success, error: err.error, durationMs: +err.durationMs.toFixed(3) },
    },
    summary,
    results,
  }

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')

  console.log('')
  console.log(`summary: ${summary.ok} ok / ${summary.error} error / ${summary.total} total`)
  console.log(`evidence written -> ${EVIDENCE_PATH}`)

  if (summary.error > 0) {
    console.error(`FAIL: ${summary.error} example(s) did not evaluate cleanly`)
    process.exit(1)
  }
  runtime.terminate()
  process.exit(0)
}

main().catch((e) => {
  console.error('smoke failed:', e)
  process.exit(1)
})
