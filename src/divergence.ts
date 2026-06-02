// W3.5: pure cross-runtime divergence detection. Comparison rule (Locked Decision
// #8, ARCHITECTURE.md "Divergence Detection"): each value is normalised by
// recursively sorting object keys at every depth then serialising to a canonical
// string; the strings are byte-compared. No float epsilon, no "close enough", no
// whitespace allowance. Sorted keys mean object key order never spuriously
// diverges; array order IS significant. DOM-free by design so runtime-matrix.ts
// owns every side effect and this stays unit-testable.

import type { EvaluationResult, RuntimeName } from './runtimes/types'

const RUNTIME_ORDER: readonly RuntimeName[] = ['js', 'python', 'go']

export type RuntimeOutcome = 'match' | 'diff' | 'error'

export type DivergenceCategory = 'ALL_MATCH' | 'SOME_DIFFER' | 'ALL_ERROR' | 'MIXED_ERROR_OK'

export interface DivergenceReport {
  category: DivergenceCategory
  // Partial: keyed only by runtimes present in the input, so an absent (not-yet
  // loaded) runtime reads as undefined instead of a fabricated outcome.
  runtimes: Partial<Record<RuntimeName, RuntimeOutcome>>
  divergentValues?: { runtime: RuntimeName; value: string }[]
}

export function isDivergent(report: DivergenceReport): boolean {
  return report.category === 'SOME_DIFFER' || report.category === 'MIXED_ERROR_OK'
}

export function detectDivergence(results: EvaluationResult[]): DivergenceReport {
  const runtimes: Partial<Record<RuntimeName, RuntimeOutcome>> = {}

  if (results.length === 0) {
    return { category: 'ALL_MATCH', runtimes }
  }

  const successes = results.filter((r) => r.success)
  const errors = results.filter((r) => !r.success)

  let category: DivergenceCategory
  if (successes.length === 0) {
    category = 'ALL_ERROR'
  } else if (errors.length === 0) {
    const first = normalize(successes[0].value)
    const allEqual = successes.every((r) => normalize(r.value) === first)
    category = allEqual ? 'ALL_MATCH' : 'SOME_DIFFER'
  } else {
    category = 'MIXED_ERROR_OK'
  }

  for (const r of errors) {
    runtimes[r.runtime] = 'error'
  }

  // Largest normalised-value group is the consensus ('match'); the rest are
  // 'diff'. topCount tracks a tie for largest, i.e. no consensus.
  const groups = new Map<string, RuntimeName[]>()
  for (const r of successes) {
    const key = normalize(r.value)
    const arr = groups.get(key)
    if (arr) arr.push(r.runtime)
    else groups.set(key, [r.runtime])
  }
  let maxSize = 0
  let topCount = 0
  let topKey = ''
  for (const [key, names] of groups) {
    if (names.length > maxSize) {
      maxSize = names.length
      topCount = 1
      topKey = key
    } else if (names.length === maxSize) {
      topCount++
    }
  }
  const hasConsensus = maxSize > 1 && topCount === 1

  for (const r of successes) {
    if (category === 'ALL_MATCH') {
      runtimes[r.runtime] = 'match'
    } else if (hasConsensus) {
      runtimes[r.runtime] = normalize(r.value) === topKey ? 'match' : 'diff'
    } else {
      // Lone success (rest errored) is not itself wrong, so 'match'; multiple
      // successes with no consensus are all 'diff'.
      runtimes[r.runtime] = successes.length === 1 ? 'match' : 'diff'
    }
  }

  const report: DivergenceReport = { category, runtimes }
  if (isDivergent(report)) {
    report.divergentValues = orderRuntimes(results).map((r) => ({
      runtime: r.runtime,
      value: displayValue(r),
    }))
  }
  return report
}

function orderRuntimes(results: EvaluationResult[]): EvaluationResult[] {
  return [...results].sort((a, b) => RUNTIME_ORDER.indexOf(a.runtime) - RUNTIME_ORDER.indexOf(b.runtime))
}

// Recursively sorts object keys, preserves array order, and gives every value a
// deterministic byte-comparable form. Exported for unit tests. Never throws: the
// bigint 'n' suffix keeps it distinct from an equal Number, and non-finite /
// function / symbol values get stable tokens JSON.stringify would drop or reject.
export function normalize(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const t = typeof value
  if (t === 'number') {
    const n = value as number
    return Number.isFinite(n) ? JSON.stringify(n) : String(n)
  }
  if (t === 'bigint') return `${(value as bigint).toString()}n`
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (t === 'function' || t === 'symbol') return `[${t}]`

  if (Array.isArray(value)) {
    return '[' + value.map(normalize).join(',') + ']'
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + normalize(obj[k])).join(',') + '}'
}

// One-line value (as it came back, NOT the sorted-key form) or error message, for
// the side-by-side comparison view.
function displayValue(r: EvaluationResult): string {
  if (!r.success) return r.error?.message ?? 'error'
  return inlineValue(r.value)
}

function inlineValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  try {
    const s = JSON.stringify(value)
    return s === undefined ? String(value) : s
  } catch {
    return String(value)
  }
}
