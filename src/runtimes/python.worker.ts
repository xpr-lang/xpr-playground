/// <reference lib="webworker" />
// Web Worker that boots a self-hosted Pyodide 0.27.5 runtime, installs the
// vendored xpr-lang wheel (no CDN / PyPI egress), and evaluates XPR expressions.
// Locked Decision #9 makes the Python runtime terminate-per-eval, so the owning
// PythonRuntime adapter (python.ts) primes a worker with `init`, runs one `eval`,
// then terminates it to reclaim Pyodide's multi-MB heap.
//
// Wire protocol with PythonRuntime (see python.ts):
//   main -> worker:  { type: 'init' }                 prime: boot + install wheel
//                    { type: 'eval', id, expr, ctx }  evaluate one expression
//   worker -> main:  { type: 'progress', value }      0..100 boot milestones
//                    { type: 'ready' }                 init complete
//                    { type: 'error', message }        init failed
//                    { type: 'result', id, success, value?, error?, durationMs }

const PYODIDE_MJS_URL = '/vendor/pyodide-0.27.5/pyodide.mjs'
const PYODIDE_INDEX_URL = '/vendor/pyodide-0.27.5/'
const WHEEL_URL = '/vendor/wheels/xpr_lang-0.5.0-py3-none-any.whl'

// Structural typing for the Pyodide surface we touch; the runtime is vendored,
// not an npm dependency, so there are no shipped types to import.
interface PyProxy {
  destroy(): void
}
interface MicropipProxy extends PyProxy {
  install(requirements: string): Promise<void>
}
interface PyodideInterface {
  loadPackage(names: string | string[]): Promise<void>
  pyimport(name: string): MicropipProxy
  runPythonAsync(code: string, options?: { globals?: PyProxy }): Promise<unknown>
  toPy(obj: unknown): PyProxy
}
type LoadPyodide = (options: { indexURL: string }) => Promise<PyodideInterface>

interface InitRequest {
  type: 'init'
}
interface EvalRequest {
  type: 'eval'
  id: number
  expr: string
  ctx: Record<string, unknown>
}
type Inbound = InitRequest | EvalRequest

type Envelope = { ok: true; value: unknown } | { ok: false; error: string }

// `expr` and `ctx` arrive as Python values via fresh `globals` (see handleEval),
// never interpolated into source, so a user expression cannot inject Python. The
// try/except keeps xpr-lang exceptions Python-side and returns a JSON envelope, so
// the adapter never sees a thrown exception (or a leaked PyProxy) for a user error.
const ENTRY = `
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function postProgress(value: number): void {
  self.postMessage({ type: 'progress', value })
}

let bootPromise: Promise<PyodideInterface> | null = null

async function boot(): Promise<PyodideInterface> {
  postProgress(5)
  // Import the vendored ESM by a fully-qualified origin URL. Vite dev's import
  // analysis rewrites specifiers starting with '/' or '.' (it appends ?import,
  // which 500s for this raw public asset); a full http(s) URL is passed through
  // untouched in dev and resolves against the deployment origin in the built
  // worker. @vite-ignore additionally stops Vite from trying to bundle it.
  const mjsUrl = new URL(PYODIDE_MJS_URL, self.location.origin).href
  const mod = (await import(/* @vite-ignore */ mjsUrl)) as { loadPyodide: LoadPyodide }
  postProgress(15)
  // indexURL must be explicit (bundlers rewrite relative URLs); Pyodide resolves
  // wasm/stdlib/lock/wheels against it.
  const pyodide = await mod.loadPyodide({ indexURL: PYODIDE_INDEX_URL })
  postProgress(70)
  // micropip + packaging are vendored under indexURL and listed in
  // pyodide-lock.json, so loadPackage resolves them locally (no CDN).
  await pyodide.loadPackage('micropip')
  postProgress(80)
  const micropip = pyodide.pyimport('micropip')
  // Install the local wheel with micropip's DEFAULT deps resolution. micropip
  // fetches over http(s) only (a '/'-path parses as file:// and is rejected as
  // "non-remote"), so resolve to a same-origin URL. Do NOT pass deps=False: it is
  // broken in micropip 0.8.0 for direct-URL installs (transaction.py only awaits
  // the wheel download inside `if self.deps:`, so deps=False raises "attempted to
  // install wheel before downloading it?"). xpr-lang's only Requires-Dist are dev
  // extras (pytest, pyyaml; marker extra == 'dev'), not requested here, so micropip
  // fetches zero dependencies and makes zero PyPI/CDN requests anyway.
  await micropip.install(new URL(WHEEL_URL, self.location.origin).href)
  micropip.destroy()
  postProgress(90)
  await pyodide.runPythonAsync('from xpr import Xpr')
  postProgress(100)
  return pyodide
}

function ensureBooted(): Promise<PyodideInterface> {
  if (bootPromise === null) bootPromise = boot()
  return bootPromise
}

async function handleEval(id: number, expr: string, ctx: Record<string, unknown>): Promise<void> {
  let pyodide: PyodideInterface
  try {
    pyodide = await ensureBooted()
  } catch (err) {
    self.postMessage({
      type: 'result',
      id,
      success: false,
      error: { message: `Python runtime failed to start: ${errMessage(err)}` },
      durationMs: 0,
    })
    return
  }

  const globals = pyodide.toPy({ _expr: expr, _ctx_json: JSON.stringify(ctx) })
  const t0 = performance.now()
  try {
    const jsonStr = (await pyodide.runPythonAsync(ENTRY, { globals })) as string
    const durationMs = performance.now() - t0
    const envelope = JSON.parse(jsonStr) as Envelope
    if (envelope.ok) {
      self.postMessage({ type: 'result', id, success: true, value: envelope.value, durationMs })
    } else {
      self.postMessage({ type: 'result', id, success: false, error: { message: envelope.error }, durationMs })
    }
  } catch (err) {
    // Safety net for a Pyodide-level failure (the entry code itself failing to
    // run); xpr-lang user errors are already handled by the envelope above.
    self.postMessage({
      type: 'result',
      id,
      success: false,
      error: { message: errMessage(err) },
      durationMs: performance.now() - t0,
    })
  } finally {
    globals.destroy()
  }
}

self.onmessage = (event: MessageEvent<Inbound>): void => {
  const msg = event.data
  if (msg.type === 'init') {
    ensureBooted().then(
      () => self.postMessage({ type: 'ready' }),
      (err: unknown) => self.postMessage({ type: 'error', message: errMessage(err) }),
    )
    return
  }
  void handleEval(msg.id, msg.expr, msg.ctx)
}
