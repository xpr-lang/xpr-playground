# Known cross-runtime divergences

This is the catalog referenced from `ARCHITECTURE.md` ("Divergence Detection").
It records the expressions whose results are **expected** to differ between the
JavaScript, Python, and Go runtimes, and explains why each difference is a
property of the underlying runtime rather than an XPR bug.

The cross-runtime equivalence gate (`scripts/cross-runtime-test.mjs`, run via
`bun run test:cross-runtime`) asserts that all 16 playground examples in
`cross-runtime.json` produce **byte-identical** output across the three runtimes
after normalization. The entries below are the only differences the gate
tolerates; every one of them is also listed in the `knownDivergences` array of
`cross-runtime.json` so the runner can prove the divergence still occurs and
print exactly which exceptions it tolerated. Any divergence NOT listed here is a
hard failure.

## Comparison rule (how "identical" is defined)

Each value is normalized before comparison (the `normalize` function in
`src/divergence.ts`, Locked Decision #8):

- object keys are sorted recursively at every depth,
- array order is preserved (it is significant),
- the result is serialised to a single canonical string and compared byte for
  byte.

There is **no** float tolerance, **no** "close enough", and **no** whitespace
allowance. Sorted keys mean object key order never causes a spurious divergence;
everything else must match exactly.

## The 16 examples do NOT diverge

All 16 examples in `cross-runtime.json` (map, filter, template, optional
chaining, reduce, let bindings, spread merge, date formatting, regex extraction,
regex literals, destructuring, destructuring-in-map, math constants, collection
helpers, type checking, negative indexing) evaluate to identical normalized JSON
in JS, Python, and Go. They are benign by construction and the gate requires
16/16 to match. The divergences below use regex features that the 16 examples
deliberately avoid.

## Catalogued divergences

### 1. Unicode `\w` versus ASCII `\w`

| | |
|---|---|
| **id** | `regex_unicode_word` |
| **expression** | `matchAll("café", "\w+")` |
| **context** | `{}` |

| Runtime | Result |
|---------|--------|
| JavaScript | `["caf"]` |
| Python | `["café"]` |
| Go | `["caf"]` |

**Why:** Python's `re` module treats `\w` as Unicode-aware by default, so it
matches the accented `é` and returns the single token `"café"`. JavaScript's
default `RegExp` (no `u` flag with Unicode property escapes) and Go's RE2 engine
both treat `\w` as the ASCII class `[A-Za-z0-9_]`, so they stop at `é` and return
`"caf"`. This is a documented difference in the host regex engines, not an XPR
defect. (Inline flags such as `(?i)` are normalised by XPR and behave the same in
all three runtimes; only the Unicode `\w` semantics differ.)

### 2. Lookbehind assertions (Go RE2)

| | |
|---|---|
| **id** | `regex_lookbehind` |
| **expression** | `match("foobar", "(?<=foo)bar")` |
| **context** | `{}` |

| Runtime | Result |
|---------|--------|
| JavaScript | `"bar"` |
| Python | `"bar"` |
| Go | error: `invalid regex pattern: error parsing regexp: invalid named capture: ` `` `(?<=foo)bar` `` |

**Why:** JavaScript and Python support lookbehind assertions and return the
matched `"bar"`. Go's standard library uses the RE2 engine, which guarantees
linear-time matching by forbidding lookaround. RE2 parses the leading `(?<` as
the start of a named-capture group `(?<name>...)`, finds `=foo` is not a valid
group name, and raises a compile error. There is no RE2 flag that enables
lookbehind; this is a deliberate engine trade-off (linear-time safety) rather
than a missing feature.

## Non-divergence worth recording: `2**53 + 1`

`ARCHITECTURE.md` mentions large-integer overflow as a thing divergence
detection would catch. In practice it does **not** diverge through this
pipeline, and it is **not** an entry in `knownDivergences`:

- Expression `9007199254740993` (which is `2**53 + 1`) returns
  `9007199254740992` from **all three** runtimes.
- JavaScript parses numeric literals with IEEE-754 doubles, so the `+1` is lost
  before the value ever leaves xpr-js.
- Go marshals an exact `int64`, and Python's `json.dumps` is exact, but the
  result of both crosses the worker boundary as a JSON string that the main
  thread parses with `JSON.parse`, collapsing it to the same IEEE-754 double
  (`9007199254740992`).

For this to surface as a real divergence, a runtime would have to carry the
exact integer across the boundary as a `BigInt` or string. None do today, so the
three runtimes agree and the gate (correctly) reports no divergence. This is
recorded here as a by-design non-divergence so a future reader does not mistake
the agreement for a bug in the detector.
