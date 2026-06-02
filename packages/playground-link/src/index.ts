import { strToU8, zlibSync } from 'fflate'

/** Runtimes the playground can activate. Canonical ids (see storage.ts `Runtime`). */
export type XprRuntime = 'js' | 'python' | 'go'

export interface XprPlaygroundLinkOptions {
  /** Evaluation context. An object is `JSON.stringify`'d; a string is used verbatim. Default `'{}'`. */
  ctx?: object | string
  /** Runtimes the playground activates on open. Default `['js', 'python', 'go']`. */
  runtimes?: readonly XprRuntime[]
  /** Playground base URL (trailing slash recommended). Default `https://xpr-playground.pages.dev/`. */
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://xpr-playground.pages.dev/'
const DEFAULT_RUNTIMES: readonly XprRuntime[] = ['js', 'python', 'go']

// RFC 4648 §5 base64url of zlib bytes. Byte-identical to the playground's
// `encodeStateV2`/`bytesToBase64Url` (xpr-playground/src/main.ts): replace
// `+`->`-`, `/`->`_`, strip `=` padding. The chunked `for...of` loop avoids the
// spread-arg stack limit on large buffers and types each byte as `number`.
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodePayload(s: string): string {
  return bytesToBase64Url(zlibSync(strToU8(s), { level: 9 }))
}

/**
 * Build a deep link into the XPR Playground that restores `expr`, `ctx`, and
 * the active `runtimes`. Produces the playground's `v=2` share URL:
 * `<baseUrl>#v=2&e=<b64url>&c=<b64url>&r=<csv>`.
 *
 * @example
 * xprPlaygroundLink('1 + 2')
 * // => 'https://xpr-playground.pages.dev/#v=2&e=...&c=...&r=js,python,go'
 *
 * xprPlaygroundLink('user.name', { ctx: { user: { name: 'Ada' } }, runtimes: ['js'] })
 */
export function xprPlaygroundLink(expr: string, opts: XprPlaygroundLinkOptions = {}): string {
  const ctx =
    opts.ctx === undefined ? '{}' : typeof opts.ctx === 'string' ? opts.ctx : JSON.stringify(opts.ctx)
  const runtimes = (opts.runtimes ?? DEFAULT_RUNTIMES).join(',')
  const base = opts.baseUrl ?? DEFAULT_BASE_URL
  return `${base}#v=2&e=${encodePayload(expr)}&c=${encodePayload(ctx)}&r=${runtimes}`
}
