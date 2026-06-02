# @xpr-lang/playground-link

Tiny, dependency-light URL builder for deep-linking expressions into the
[XPR Playground](https://xpr-playground.pages.dev/).

It produces the playground's `v=2` share URL — an
[`fflate`](https://github.com/101arrowz/fflate) zlib-compressed, base64url-encoded
`#v=2&e=...&c=...&r=...` hash. Open the URL and the playground restores the
expression, context, and active runtimes byte-for-byte.

## Install

```bash
npm install @xpr-lang/playground-link
```

## Usage

```ts
import { xprPlaygroundLink } from '@xpr-lang/playground-link'

// Minimal -- defaults ctx to '{}' and runtimes to js, python, go
xprPlaygroundLink('1 + 2')
// => https://xpr-playground.pages.dev/#v=2&e=...&c=...&r=js,python,go

// With context (an object is JSON-stringified) and a runtime subset
xprPlaygroundLink('user.name', {
  ctx: { user: { name: 'Ada' } },
  runtimes: ['js'],
})

// Self-hosting? Point at your own deployment
xprPlaygroundLink('items.map(x => x.id)', { baseUrl: 'http://localhost:5173/' })
```

## API

### `xprPlaygroundLink(expr, options?) => string`

| Option | Type | Default | Notes |
| ------ | ---- | ------- | ----- |
| `ctx` | `object \| string` | `'{}'` | An object is `JSON.stringify`'d; a string is used verbatim. |
| `runtimes` | `('js' \| 'python' \| 'go')[]` | `['js', 'python', 'go']` | Runtimes the playground activates on open. |
| `baseUrl` | `string` | `https://xpr-playground.pages.dev/` | Trailing slash recommended; the `#...` hash is appended directly. |

The output is byte-compatible with the playground's `v=2` decoder, so any
generated link round-trips exactly (see `test.mjs`).

## License

MIT
