# XPR Playground — Architecture Decision Notes

> Status: Reflects the shipped v2 architecture. Implementation lives in `src/`, `public/vendor/`, and the Cloudflare Pages deploy at https://xpr-playground.pages.dev/.

## Overview

The playground is a single-page web application that lets users write XPR expressions, provide a JSON context, and see results from multiple runtimes simultaneously.

---

## Editor Component

### Option A: CodeMirror 6 ✅ Recommended

**Pros:**
- Modular architecture — only load what you need
- Smaller bundle (~50KB for core vs Monaco's ~5MB)
- Designed for embedding in web apps
- Easy to add custom language support (XPR syntax highlighting)
- Active development, good TypeScript support

**Cons:**
- Less familiar to VS Code users
- Fewer built-in themes

### Option B: Monaco Editor

**Pros:**
- VS Code's editor — familiar to developers
- Rich built-in features (IntelliSense, diff view)

**Cons:**
- Very large bundle (~5MB+)
- Designed for full IDE use, overkill for a playground
- Harder to customize for a custom language

**Decision:** CodeMirror 6. The playground is expression-focused, not a full IDE. Bundle size matters for a web app.

---

## JavaScript Runtime

**Approach:** Direct browser bundle of `@xpr-lang/xpr`

- Import the ESM bundle directly in the browser
- Zero server round-trips for JS evaluation
- Runs client-side via WebWorker (for timeout enforcement)
- Bundle size: ~40KB (already built)

**No server needed for JS runtime.**

---

## Python Runtime

### Option A: Pyodide (Python in WASM) ✅ Recommended for v1

**Pros:**
- Runs entirely client-side
- No server infrastructure needed
- Full CPython in the browser

**Cons:**
- Large initial download (Pyodide 0.27.5 is 13.3 MB on disk; roughly 3 to 4 MB over the wire after brotli, because `pyodide.asm.wasm` alone is 9.64 MB)
- Slow first load
- Memory usage

### Option B: Server-side API

**Pros:**
- Fast, no WASM overhead
- Can use any Python version

**Cons:**
- Requires server infrastructure
- Latency on each evaluation
- Rate limiting complexity

**Decision:** Self-hosted Pyodide 0.27.5 under `public/vendor/pyodide-0.27.5/`. No runtime CDN: `micropip` and `packaging` wheels are vendored alongside Pyodide because PyPI's published versions do not match the SHA256s that `pyodide-lock.json` expects. The `xpr-lang` Python wheel (`xpr_lang-0.5.0-py3-none-any.whl`, 21 KB) is vendored at `public/vendor/wheels/` and installed via `micropip` after Pyodide boots.

---

## Go Runtime

**Approach:** Stock Go 1.24+ compiled to WASM, runs client-side in a Web Worker.

- Build: `GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o xpr-go.wasm ./cmd/wasm/`
- Artifact: `public/xpr-go.wasm` (4.74 MB raw, 1.29 MB gzip, 953 KB brotli, verified W0.3)
- Loader glue: `public/wasm_exec.js`, copied verbatim from `$GOROOT/lib/wasm/wasm_exec.js` (Go 1.24+ canonical path; the pre-1.24 `misc/wasm/` location no longer exists)
- Shim entry point: `globalThis.xprGoEvaluate(expression, contextJSON) -> envelope JSON`

### TinyGo evaluated and rejected

TinyGo was evaluated empirically and rejected:

- `encoding/json.Marshal` requires runtime reflection that TinyGo's stdlib does not implement
- `fmt.Sprintf("%v", any)` likewise depends on `reflect`, which TinyGo only partially supports
- xpr-go's evaluator and serialisation paths use both, so a TinyGo build fails to compile

Stock Go's 4.74 MB raw artifact compresses to 953 KB over brotli, well inside any reasonable budget for a developer tool. The previous concern about "10 MB+ Go WASM" was based on unstripped builds without `-ldflags="-s -w"`; stripping symbols and DWARF reclaims roughly 8%, and brotli at the edge does the rest.

### Server-side API rejected

A server-side Go evaluation API was the original v1 fallback. It is no longer needed: the WASM artifact ships with the playground, evaluation is local, and there is no rate-limited backend to operate.

### Critical quirks

- `cmd/wasm/main.go` MUST carry a `//go:build js && wasm` build constraint, otherwise `go vet ./...` fails on the host architecture because `syscall/js` is itself gated by the same tag.
- The Go runtime is kept alive with `<-make(chan struct{})` so `xprGoEvaluate` remains callable; the Promise returned by `go.run(instance)` therefore never resolves. Callers MUST NOT `await` it.
- The shim returns a JSON envelope: `{"result": "<JSON-encoded value>"}` on success, `{"error": "<message>"}` on failure. The result field is itself JSON-encoded, so callers parse twice. This avoids round-tripping arbitrary Go `interface{}` through `syscall/js`.

---

## Runtime Architecture

Each runtime evaluates in its own dedicated Web Worker. The main thread orchestrates dispatch and surfaces results; it never blocks on user code.

| Runtime | Lifecycle | Reason |
|---------|-----------|--------|
| JavaScript | Persistent (reused across evaluations) | Module init cost is low; `new Xpr().evaluate()` is stateless, so no risk of state leaking between unrelated XPR runs |
| Python | Terminated and recreated after every evaluation | Pyodide's heap grows on each module import and string allocation; recreating the worker is the cheapest way to reclaim memory and guarantee a clean module table |
| Go | Terminated and recreated after every evaluation | Go's WASM heap is also long-lived; the runtime's `go.run()` blocks forever to keep `xprGoEvaluate` callable, so the only way to free memory is worker termination |

### Why per-eval termination for Python and Go

Holding onto a Pyodide instance or a Go WASM instance between evaluations leaks memory monotonically. Every JSON parse, every `re.compile`, every Go map allocated for context survives until the worker dies. On iOS Safari this causes the runtime to be reaped silently after a few minutes of editing. Terminating the worker after each result is a heap-hygiene measure first and a defense-in-depth isolation measure second.

The cost is a fresh worker boot per evaluation: roughly 150 ms for Python (Pyodide `indexURL` is local, micropip is pre-installed), roughly 50 ms for Go (the WASM module is cached by the browser after the first fetch). Both numbers stay under the 300 ms debounce window between keystrokes.

### iOS Safari Worker memory

iOS Safari aggressively reaps Web Workers when the tab loses visibility. A `visibilitychange` listener on the main thread checks for dead workers when the tab is foregrounded again and recreates them on demand, so coming back to the tab does not surface a stale "no result" state.

### Asset locations

- `public/vendor/pyodide-0.27.5/` (8 files, 13.3 MB total): `pyodide.asm.js` (1.20 MB), `pyodide.asm.wasm` (9.64 MB), `pyodide.mjs` (14 KB), `python_stdlib.zip` (2.25 MB), `pyodide-lock.json` (110 KB), `micropip-0.8.0-py3-none-any.whl` (47 KB), `packaging-24.2-py3-none-any.whl` (70 KB), and Pyodide's own `package.json`
- `public/vendor/wheels/xpr_lang-0.5.0-py3-none-any.whl` (21 KB)
- `public/xpr-go.wasm` (4.74 MB raw, 953 KB brotli)
- `public/wasm_exec.js` (16,992 bytes, Go 1.24+)

Everything is served from the same origin. There is no runtime fetch from jsdelivr, unpkg, or any other CDN.

### CSP

The deploy ships with:

```
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
img-src 'self' data:;
```

`wasm-unsafe-eval` is required for both Pyodide and the Go runtime. `blob:` workers are needed for Pyodide's internal worker spawning. No `'unsafe-inline'`, no third-party origins.

### No service worker

v2 ships without a service worker. The deploy-cache invalidation hazards (a stale SW serving stale Pyodide WASM or stale `xpr-go.wasm` for hours after a deploy) outweigh the offline-mode benefit. The previous GitHub Pages SW lives on a different origin and cannot affect the Cloudflare Pages deploy.

---

## Divergence Detection

When a single XPR expression runs in two or more runtimes, the playground compares their results to surface real cross-runtime differences. The comparison is intentionally strict.

### Comparison rule

1. Each runtime returns a JSON-serialisable result.
2. Results are normalised by re-serialising with sorted object keys.
3. Two normalised strings that are not byte-identical are reported as a divergence.

There is no epsilon for floating point, no "close enough" for numeric types, no whitespace allowance. If `2^53 + 1` overflows JavaScript's `Number` to `9007199254740992` while Python returns `9007199254740993`, the playground shows two distinct cells and flags the row.

### What this catches

- Integer overflow past `Number.MAX_SAFE_INTEGER`
- Integer-versus-float coercion differences (e.g. `5 / 2` returning `2.5` in JS but `2` in some Python paths)
- Regex flag and feature mismatches (Go's `regexp` is RE2-only; JS supports lookbehind; Python's `re` differs again on Unicode property escapes)
- Locale-sensitive string operations when one runtime is locale-aware and another is not
- Date and time precision, plus timezone behaviour at DST boundaries

### Documented divergences

Known, expected divergences are catalogued in `tests/fixtures/known-divergences.md`. That file is the place to record a divergence that is by design (for instance JS `Number` versus Python `int` range) and should not be treated as a regression in CI. The playground UI surfaces every divergence equally; the fixtures file is the human-readable log of which ones have been triaged.

---

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  XPR Playground                              [Share] [?] │
├──────────────────────────┬──────────────────────────────┤
│  Expression              │  Context (JSON)               │
│  ┌────────────────────┐  │  ┌────────────────────────┐  │
│  │ items.filter(      │  │  │ {                      │  │
│  │   x => x.price > 50│  │  │   "items": [...]       │  │
│  │ ).map(x => x.name) │  │  │ }                      │  │
│  └────────────────────┘  │  └────────────────────────┘  │
├──────────────────────────┴──────────────────────────────┤
│  Results                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ JS       │  │ Python   │  │ Go       │              │
│  │ ["Widget"]│  │ ["Widget"]│  │ ["Widget"]│              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

---

## Frontend Framework

### Options Considered

| Framework | Bundle Size | Reactivity | Complexity |
|-----------|-------------|------------|------------|
| Solid.js  | ~7KB        | Fine-grained | Low |
| Preact    | ~4KB        | VDOM        | Low |
| Vanilla JS | 0KB        | Manual DOM  | Medium |
| React     | ~45KB       | VDOM        | Low |

**Decision:** Solid.js or Preact. The playground is a single page — React's overhead is unnecessary. Solid.js has excellent fine-grained reactivity for live evaluation.

---

## URL State Format

State (expression, context, optional runtime selection) round-trips through the URL hash so any view of the playground is reproducible by sharing the link. No server is involved.

### v=2 (current)

```
#v=2&e=<fflate-zlib-base64>&c=<fflate-zlib-base64>&r=<csv>
```

- `v=2`: format version sentinel; the parser dispatches on this
- `e`: expression text, deflated with `fflate` zlib then base64-encoded
- `c`: context JSON, same encoding
- `r`: comma-separated list of selected runtime ids (`js`, `python`, `go`). Omitted means JS-only.

Zlib compression more than doubles the practical payload that fits inside the ~2000 character URL ceiling. Browsers tested handle hash strings well above that limit, but staying under 2000 chars keeps share buttons, chat clients, and email gateways happy.

### v=1 (legacy, kept working)

```
#e=<base64-utf8>&c=<base64-utf8>
```

Pre-v2 links used straight base64 of the UTF-8 source. These URLs remain valid forever: the fallback parser detects the missing `v=` sentinel and decodes them with the old algorithm. Removing v=1 support would break every previously shared link, including those embedded in xpr-docs and external blog posts.

New shares always emit v=2; v=1 is read-only.

---

## XPR Syntax Highlighting (Future)

CodeMirror 6 supports custom language grammars via `@codemirror/language`. A future task would define:
- Token types: keywords, operators, strings, numbers, identifiers
- Bracket matching for `()`, `[]`, `{}`
- Auto-close for quotes and brackets

This requires the XPR tokenizer to be exposed as a CodeMirror language extension.

---

## Deployment

- **Cloudflare Pages** at https://xpr-playground.pages.dev/ (no custom domain at launch).
- **No server-side anything.** All three runtimes execute in the browser. There is no Go API, no rate limiter, no auth layer, no database.
- **Brotli compression at the edge.** Cloudflare Pages applies brotli automatically to text and WASM, which is what makes the 4.74 MB Go binary and the 9.64 MB Pyodide WASM tolerable over the wire.
- **GitHub Actions deploys on push to `main`** via the official Cloudflare Pages action; workflow at `.github/workflows/deploy.yml`.
- **Cloudflare Web Analytics** is the only telemetry: cookieless, GDPR-clean, no IDs sent to third parties.

---

## Future Considerations

- **Conformance test runner UI** — run all conformance tests in the browser
- **Diff view** — compare output across runtimes
- **Error highlighting** — highlight the position of parse/eval errors in the editor
- **Examples gallery** — pre-loaded expression examples
