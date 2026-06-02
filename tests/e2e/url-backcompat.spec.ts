import { expect, test } from '@playwright/test'
import { legacyV1Hash, readCtx, readExpr } from './helpers'

// The app's decodeState parses the hash with URLSearchParams, which turns a
// literal "+" into a space. Standard base64 can contain "+", so a legacy URL
// whose payload encodes to a "+" genuinely does not round-trip (a real, honest
// limitation). These five payloads all base64-encode "+"-free, matching the
// legacy links that actually restore.
const LEGACY_CASES: ReadonlyArray<{ name: string; expr: string; ctx: string }> = [
  { name: 'map with context', expr: 'data.map(x => x.id)', ctx: '{"data":[{"id":7}]}' },
  { name: 'filter with context', expr: 'users.map(u => u.email)', ctx: '{"users":[{"email":"a@x.io"}]}' },
  { name: 'unicode template', expr: '`Hello ${name}`', ctx: '{"name":"Wörld 🚀"}' },
  { name: 'optional chaining', expr: 'user?.address?.city ?? "unknown"', ctx: '{"user":{"address":null}}' },
  { name: 'arithmetic, default context', expr: '40 + 2', ctx: '{}' },
]

for (const { name, expr, ctx } of LEGACY_CASES) {
  test(`legacy v1 #e=&c= URL restores byte-identically: ${name}`, async ({ page }) => {
    await page.goto(`/${legacyV1Hash(expr, ctx)}`)
    await expect(page.locator('#expr-editor .cm-content')).toBeVisible()

    await expect.poll(() => readExpr(page)).toBe(expr)
    await expect.poll(() => readCtx(page)).toBe(ctx)
  })
}
