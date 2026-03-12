# XPR Playground — Architecture Decision Notes

> Status: Architecture phase. These are decisions and trade-offs, not final choices.

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
- Large initial download (~10MB for Pyodide)
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

**Decision:** Pyodide for v1 (simpler deployment). Server-side API as fallback/v2 if Pyodide proves too slow.

---

## Go Runtime

### Option A: TinyGo WASM

**Pros:**
- Client-side, no server needed
- Small WASM binary (TinyGo produces ~1-2MB vs standard Go's ~10MB+)

**Cons:**
- TinyGo has stdlib limitations
- Compilation step required for each release
- Complex build pipeline

### Option B: Server-side API ✅ Recommended for v1

**Pros:**
- Standard Go, no TinyGo limitations
- Simple deployment (single Go binary)
- Fast evaluation

**Cons:**
- Requires server infrastructure
- Latency

**Decision:** Server-side API for Go. TinyGo WASM is complex and has stdlib gaps that may affect the runtime.

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

## URL Sharing

- Encode expression + context as base64 in URL hash: `#e=<base64>&c=<base64>`
- No server needed for sharing
- Limit: ~2000 chars URL length (sufficient for most expressions)

---

## XPR Syntax Highlighting (Future)

CodeMirror 6 supports custom language grammars via `@codemirror/language`. A future task would define:
- Token types: keywords, operators, strings, numbers, identifiers
- Bracket matching for `()`, `[]`, `{}`
- Auto-close for quotes and brackets

This requires the XPR tokenizer to be exposed as a CodeMirror language extension.

---

## Deployment

- Static hosting (Vercel, Netlify, GitHub Pages) for the frontend
- Optional: small Go API server for Go runtime evaluation
- No database needed

---

## Future Considerations

- **Conformance test runner UI** — run all conformance tests in the browser
- **Diff view** — compare output across runtimes
- **Error highlighting** — highlight the position of parse/eval errors in the editor
- **Examples gallery** — pre-loaded expression examples
