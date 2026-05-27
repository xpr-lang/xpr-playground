#!/usr/bin/env bun
// Round-trip smoke for W2.3 share-URL format.
// Replicates the exact encode/decode functions from src/main.ts so we can
// exercise the algorithm headlessly without spinning a browser.

import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'

function b64EncodeUtf8(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}
function b64DecodeUtf8(s) {
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)))
}
function bytesToBase64Url(bytes) {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64UrlToBytes(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function encodeStateV2(expr, ctx, runtimes) {
  const e = bytesToBase64Url(zlibSync(strToU8(expr), { level: 9 }))
  const c = bytesToBase64Url(zlibSync(strToU8(ctx), { level: 9 }))
  return `#v=2&e=${e}&c=${c}&r=${runtimes.join(',')}`
}

function decodeState(rawHash) {
  const body = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  if (!body) return null
  const params = new URLSearchParams(body)
  if (params.get('v') === '2') {
    const e = params.get('e')
    if (!e) return null
    try {
      const expr = strFromU8(unzlibSync(base64UrlToBytes(e)))
      const c = params.get('c')
      const ctx = c ? strFromU8(unzlibSync(base64UrlToBytes(c))) : '{}'
      const rRaw = params.get('r')
      const runtimes = rRaw ? rRaw.split(',').filter(Boolean) : ['js']
      return { expr, ctx, runtimes }
    } catch {
      return null
    }
  }
  const e1 = params.get('e')
  if (e1) {
    try {
      const c1 = params.get('c')
      return {
        expr: b64DecodeUtf8(e1),
        ctx: c1 ? b64DecodeUtf8(c1) : '{}',
        runtimes: ['js'],
      }
    } catch {
      return null
    }
  }
  return null
}

let failed = 0
function check(label, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

console.log('=== W2.3 share-URL round-trip smoke ===\n')

// --- 1. v=2 happy path: short ASCII expression
{
  const expr = 'items.filter(x => x.active).map(x => x.name)'
  const ctx = '{"items":[{"name":"a","active":true}]}'
  const hash = encodeStateV2(expr, ctx, ['js'])
  console.log('v=2 hash:', hash)
  console.log('  length:', hash.length)
  const decoded = decodeState(hash)
  check('v=2 starts with #v=2&', hash.startsWith('#v=2&'))
  // Only the b64url payloads must be URL-safe; the `key=value&` separators are URL syntax.
  const payloads = [...new URLSearchParams(hash.slice(1)).values()]
  check('v=2 payloads are b64url', payloads.every(p => !/[+/=]/.test(p)))
  check('v=2 round-trip expr', decoded?.expr === expr)
  check('v=2 round-trip ctx', decoded?.ctx === ctx)
  check('v=2 round-trip runtimes', JSON.stringify(decoded?.runtimes) === '["js"]')
}

// --- 2. v=2 with unicode + emoji + long template literal
{
  const expr = '`你好 ${name}, 🚀 count=${count + 1}`'
  const ctx = JSON.stringify({ name: 'Алиса', count: 42, nested: { 中文: '★' } })
  const hash = encodeStateV2(expr, ctx, ['js', 'py', 'go'])
  console.log('\nv=2 unicode hash length:', hash.length)
  const decoded = decodeState(hash)
  check('v=2 unicode expr', decoded?.expr === expr)
  check('v=2 unicode ctx', decoded?.ctx === ctx)
  check('v=2 multi-runtime parses CSV', JSON.stringify(decoded?.runtimes) === '["js","py","go"]')
}

// --- 3. Compression actually compresses (sanity)
{
  const expr = 'x'.repeat(500) + ' + ' + 'y'.repeat(500)
  const ctx = '{}'
  const v2 = encodeStateV2(expr, ctx, ['js'])
  const v1Eq = `#e=${b64EncodeUtf8(expr)}&c=${b64EncodeUtf8(ctx)}`
  console.log(`\nrepeat-test: v=2 hash ${v2.length} bytes; equivalent v=1 ${v1Eq.length} bytes`)
  check('v=2 compresses redundant data better than v=1', v2.length < v1Eq.length / 5)
}

// --- 4. v=1 backward-compat: hand-craft a pre-W2.3 URL
{
  const oldExpr = 'users.map(u => u.email)'
  const oldCtx = '{"users":[{"email":"a@x"}]}'
  const v1Hash = `#e=${b64EncodeUtf8(oldExpr)}&c=${b64EncodeUtf8(oldCtx)}`
  console.log('\nv=1 legacy hash:', v1Hash)
  const decoded = decodeState(v1Hash)
  check('v=1 legacy decodes', decoded !== null)
  check('v=1 legacy expr matches', decoded?.expr === oldExpr)
  check('v=1 legacy ctx matches', decoded?.ctx === oldCtx)
  check('v=1 legacy default runtimes is [js]', JSON.stringify(decoded?.runtimes) === '["js"]')
}

// --- 5. Edge cases: empty / malformed / missing keys
{
  check('empty hash returns null', decodeState('') === null)
  check('"#" alone returns null', decodeState('#') === null)
  check('v=2 with no e returns null', decodeState('#v=2&c=xxx') === null)
  check('corrupted v=2 e returns null', decodeState('#v=2&e=not_valid_zlib_base64') === null)
  check('unrelated hash returns null', decodeState('#section1') === null)
}

// --- 6. v=2 missing r= defaults to ['js']
{
  const expr = '1+1'
  const ctx = '{}'
  const e = bytesToBase64Url(zlibSync(strToU8(expr), { level: 9 }))
  const c = bytesToBase64Url(zlibSync(strToU8(ctx), { level: 9 }))
  const hashNoR = `#v=2&e=${e}&c=${c}`
  const decoded = decodeState(hashNoR)
  check('v=2 missing r= defaults to [js]', JSON.stringify(decoded?.runtimes) === '["js"]')
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASS' : `FAILED: ${failed}`}`)
process.exit(failed === 0 ? 0 : 1)
