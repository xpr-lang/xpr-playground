#!/usr/bin/env node
// W4.5 round-trip: a URL produced by @xpr-lang/playground-link must decode back
// byte-identically through the playground's ACTUAL v=2 decoder. decodeState +
// base64UrlToBytes below are copied verbatim from xpr-playground/src/main.ts
// (the same logic exercised by scripts/share-url-smoke.mjs), so a PASS proves a
// generated link restores in the real app.

import { strFromU8, unzlibSync } from 'fflate'
import { xprPlaygroundLink } from './dist/index.js'

function base64UrlToBytes(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
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
  return null
}

function hashOf(url) {
  const i = url.indexOf('#')
  return i === -1 ? '' : url.slice(i)
}

let failed = 0
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!cond) failed++
}

console.log('=== W4.5 @xpr-lang/playground-link round-trip ===\n')

{
  const expr = 'items.filter(x => x.active).map(x => x.name)'
  const url = xprPlaygroundLink(expr)
  console.log('default url:', url)
  check('default base + #v=2&', url.startsWith('https://xpr-playground.pages.dev/#v=2&'))
  const d = decodeState(hashOf(url))
  check('expr round-trips', d?.expr === expr, JSON.stringify(d?.expr))
  check('ctx defaults to {}', d?.ctx === '{}')
  check('runtimes default js,python,go', JSON.stringify(d?.runtimes) === '["js","python","go"]')
  const payloads = [...new URLSearchParams(hashOf(url).slice(1)).entries()]
    .filter(([k]) => k === 'e' || k === 'c')
    .map(([, v]) => v)
  check('payloads are base64url (no +/=)', payloads.length === 2 && payloads.every(p => !/[+/=]/.test(p)))
}

{
  const expr = '`你好 ${name}, 🚀 count=${count + 1}`'
  const ctxObj = { name: 'Алиса', count: 42, nested: { 中文: '★' } }
  const url = xprPlaygroundLink(expr, { ctx: ctxObj, runtimes: ['python'] })
  console.log('\nunicode url:', url)
  const d = decodeState(hashOf(url))
  check('unicode/emoji expr round-trips', d?.expr === expr, JSON.stringify(d?.expr))
  check('object ctx is JSON-stringified + round-trips', d?.ctx === JSON.stringify(ctxObj), d?.ctx)
  check('explicit single runtime [python]', JSON.stringify(d?.runtimes) === '["python"]')
}

{
  const expr = 'x + y'
  const ctxStr = '{"x":1,"y":2}'
  const url = xprPlaygroundLink(expr, { ctx: ctxStr, runtimes: ['js', 'go'], baseUrl: 'http://localhost:5173/' })
  console.log('\ncustom-base url:', url)
  check('custom baseUrl honored', url.startsWith('http://localhost:5173/#v=2&'))
  const d = decodeState(hashOf(url))
  check('string ctx used verbatim', d?.ctx === ctxStr, d?.ctx)
  check('expr round-trips', d?.expr === expr)
  check('runtimes subset js,go', JSON.stringify(d?.runtimes) === '["js","go"]')
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASS' : `FAILED: ${failed}`}`)
process.exit(failed === 0 ? 0 : 1)
