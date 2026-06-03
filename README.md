# xpr-playground — XPR Expression Language Playground

[![CI](https://github.com/xpr-lang/xpr-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/xpr-lang/xpr-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An interactive browser-based playground for evaluating XPR expressions in JavaScript.

## Features

- **CodeMirror 6 editor** with XPR syntax highlighting (keywords, strings, numbers, operators)
- **Context editor** (JSON) for providing evaluation context
- **Live evaluation** — results update as you type (300ms debounce)
- **Shareable links** — encode expression + context in URL hash
- **Built-in examples** — map, filter, template literals, optional chaining, let bindings, spread

## Running Locally

```bash
bun install
bun run dev
```

Then open http://localhost:5173.

## Building

```bash
bun run build
```

Output goes to `dist/`.

## Packages

- [`@xpr-lang/playground-link`](packages/playground-link/) — a tiny, dependency-light URL builder for deep-linking expressions into this playground (generates the `v=2` share URL). Useful from docs sites and tooling.

## Related Repos

- [xpr-lang/xpr](https://github.com/xpr-lang/xpr) — Language specification
- [xpr-lang/xpr-js](https://github.com/xpr-lang/xpr-js) — JavaScript runtime
- [xpr-lang/xpr-python](https://github.com/xpr-lang/xpr-python) — Python runtime
- [xpr-lang/xpr-go](https://github.com/xpr-lang/xpr-go) — Go runtime
- [xpr-lang/xpr-docs](https://github.com/xpr-lang/xpr-docs) — Documentation

## License

MIT — see [LICENSE](LICENSE)
