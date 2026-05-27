// W2.6 contract:
//   1. URL hash always wins over this storage (URL = explicit intent).
//   2. Theme is owned by W1.10 under key `xpr-theme`. NOT included here.
//   3. Every localStorage access is try/catch wrapped (Safari private mode,
//      quota, and storage-disabled all throw at runtime).
//   4. Schema is versioned. To bump: increment CURRENT_VERSION and add a
//      branch in migrate() that upgrades the older shape.

const STORAGE_KEY = 'xpr-state'
const CURRENT_VERSION = 1 as const

// 100 KB cap protects the shared 5 MB origin quota: an oversized expression
// silently fails its save instead of evicting xpr-theme or other tabs' state.
const MAX_PAYLOAD_BYTES = 100_000

export type Runtime = 'js' | 'python' | 'go'

export interface StoredStateV1 {
  version: 1
  expr: string
  ctx: string
  runtimes: Runtime[]
  lastUsed: number
}

export type StoredState = StoredStateV1

const VALID_RUNTIMES: ReadonlySet<Runtime> = new Set(['js', 'python', 'go'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeRuntimes(value: unknown): Runtime[] {
  if (!Array.isArray(value)) return ['js']
  const out: Runtime[] = []
  for (const v of value) {
    if (typeof v === 'string' && VALID_RUNTIMES.has(v as Runtime) && !out.includes(v as Runtime)) {
      out.push(v as Runtime)
    }
  }
  return out.length > 0 ? out : ['js']
}

function migrate(raw: unknown): StoredStateV1 | null {
  if (!isPlainObject(raw)) return null
  if (raw.version !== undefined && raw.version !== 1) return null

  const expr = typeof raw.expr === 'string' ? raw.expr : null
  if (expr === null) return null
  const ctx = typeof raw.ctx === 'string' ? raw.ctx : '{}'

  return {
    version: CURRENT_VERSION,
    expr,
    ctx,
    runtimes: sanitizeRuntimes(raw.runtimes),
    lastUsed: typeof raw.lastUsed === 'number' ? raw.lastUsed : Date.now(),
  }
}

export function load(): StoredStateV1 | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}
    return null
  }

  return migrate(parsed)
}

export function save(state: Omit<StoredStateV1, 'version' | 'lastUsed'>): void {
  const payload: StoredStateV1 = {
    version: CURRENT_VERSION,
    expr: state.expr,
    ctx: state.ctx,
    runtimes: sanitizeRuntimes(state.runtimes),
    lastUsed: Date.now(),
  }

  let serialised: string
  try {
    serialised = JSON.stringify(payload)
  } catch {
    return
  }
  if (serialised.length > MAX_PAYLOAD_BYTES) return

  try {
    localStorage.setItem(STORAGE_KEY, serialised)
  } catch {}
}

export function clear(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}
