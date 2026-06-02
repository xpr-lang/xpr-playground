import { expect, test } from '@playwright/test'
import { activateRuntime, gotoApp, setExpr } from './helpers'

// W3.5 proved 2**53+1 does NOT diverge (uniform IEEE-754 loss across the JSON
// worker boundary), so these use the real divergences it documented instead:
// Python's Unicode-aware \w vs ASCII \w in JS/Go, and Go RE2 rejecting lookbehind.
const UNICODE_WORD = 'matchAll("café", "\\\\w+")'
const LOOKBEHIND = 'match("foobar", "(?<=foo)bar")'

test.describe('cross-runtime divergence is detected and surfaced', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page)
    await activateRuntime(page, 'python')
    await activateRuntime(page, 'go')
  })

  test('Unicode \\w makes Python diverge from JS/Go', async ({ page }) => {
    await setExpr(page, UNICODE_WORD)

    await expect(page.locator('.results-row')).toHaveClass(/diverge/, { timeout: 25_000 })
    await expect(page.locator('#result-python')).toHaveClass(/is-divergent/)
    await expect(page.locator('#result-python .divergence-badge')).toBeVisible()
  })

  test('lookbehind makes Go (RE2) diverge from JS/Python', async ({ page }) => {
    await setExpr(page, LOOKBEHIND)

    await expect(page.locator('.results-row')).toHaveClass(/diverge/, { timeout: 25_000 })
    await expect(page.locator('#result-go')).toHaveClass(/is-divergent/)
    await expect(page.locator('#result-go .divergence-badge')).toBeVisible()
  })
})
