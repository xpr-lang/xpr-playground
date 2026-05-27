#!/usr/bin/env bun
// W2.6 storage unit smoke: exercise load/save/migrate/clear in isolation.
// Mirrors the storage.ts logic without spinning a browser; matches the
// scripts/share-url-smoke.mjs pattern for consistency.

const STORAGE_KEY = 'xpr-state'
const MAX_PAYLOAD_BYTES = 100_000

function makeMemoryStorage(opts = {}) {
  const map = new Map()
  return {
    getItem(k) {
      if (opts.throwOnGet) throw new Error('storage disabled')
      return map.has(k) ? map.get(k) : null
    },
    setItem(k, v) {
      if (opts.throwOnSet) throw new Error('quota exceeded')
      map.set(k, v)
    },
    removeItem(k) {
      if (opts.throwOnRemove) throw new Error('storage disabled')
      map.delete(k)
    },
    _dump() {
      return Object.fromEntries(map)
    },
  }
}

async function loadStorage() {
  delete globalThis.__storageCache
  const mod = await import('../src/storage.ts?cache=' + Math.random())
  return mod
}

const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}

test('save then load round-trips expr/ctx/runtimes', async () => {
  globalThis.localStorage = makeMemoryStorage()
  const { save, load } = await loadStorage()
  save({ expr: '42 + 1', ctx: '{}', runtimes: ['js'] })
  const got = load()
  if (!got) throw new Error('load returned null')
  if (got.expr !== '42 + 1') throw new Error(`expr=${got.expr}`)
  if (got.ctx !== '{}') throw new Error(`ctx=${got.ctx}`)
  if (JSON.stringify(got.runtimes) !== '["js"]') throw new Error(`runtimes=${JSON.stringify(got.runtimes)}`)
  if (got.version !== 1) throw new Error(`version=${got.version}`)
  if (typeof got.lastUsed !== 'number') throw new Error(`lastUsed=${got.lastUsed}`)
})

test('load returns null when nothing stored', async () => {
  globalThis.localStorage = makeMemoryStorage()
  const { load } = await loadStorage()
  if (load() !== null) throw new Error('expected null')
})

test('save silently no-ops on setItem throw', async () => {
  globalThis.localStorage = makeMemoryStorage({ throwOnSet: true })
  const { save, load } = await loadStorage()
  save({ expr: 'x', ctx: '{}', runtimes: ['js'] })
  if (load() !== null) throw new Error('save should have no-opped')
})

test('load returns null on getItem throw', async () => {
  globalThis.localStorage = makeMemoryStorage({ throwOnGet: true })
  const { load } = await loadStorage()
  if (load() !== null) throw new Error('expected null on read throw')
})

test('oversized payload silently dropped', async () => {
  globalThis.localStorage = makeMemoryStorage()
  const { save, load } = await loadStorage()
  const big = 'a'.repeat(MAX_PAYLOAD_BYTES + 100)
  save({ expr: big, ctx: '{}', runtimes: ['js'] })
  if (load() !== null) throw new Error('oversized write should not have landed')
})

test('migrate handles unknown future version by returning null', async () => {
  globalThis.localStorage = makeMemoryStorage()
  globalThis.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 99, expr: 'x', ctx: '{}', runtimes: ['js'], lastUsed: 0 })
  )
  const { load } = await loadStorage()
  if (load() !== null) throw new Error('future version should produce null')
})

test('migrate drops invalid runtimes and defaults to [js]', async () => {
  globalThis.localStorage = makeMemoryStorage()
  globalThis.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, expr: 'x', ctx: '{}', runtimes: ['rust', 'js', 'cobol'], lastUsed: 0 })
  )
  const { load } = await loadStorage()
  const got = load()
  if (!got) throw new Error('expected loaded state')
  if (JSON.stringify(got.runtimes) !== '["js"]') throw new Error(`got=${JSON.stringify(got.runtimes)}`)
})

test('migrate rejects payload missing expr', async () => {
  globalThis.localStorage = makeMemoryStorage()
  globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ctx: '{}', runtimes: ['js'] }))
  const { load } = await loadStorage()
  if (load() !== null) throw new Error('missing expr should be null')
})

test('corrupt JSON triggers cleanup and returns null', async () => {
  const ls = makeMemoryStorage()
  ls.setItem(STORAGE_KEY, '{not json')
  globalThis.localStorage = ls
  const { load } = await loadStorage()
  if (load() !== null) throw new Error('expected null on corrupt JSON')
  if (Object.keys(ls._dump()).length !== 0) throw new Error('corrupt entry should have been cleaned')
})

test('clear removes the key', async () => {
  const ls = makeMemoryStorage()
  globalThis.localStorage = ls
  const { save, clear, load } = await loadStorage()
  save({ expr: 'x', ctx: '{}', runtimes: ['js'] })
  clear()
  if (load() !== null) throw new Error('expected null after clear')
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}: ${e.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
