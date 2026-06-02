import { expect, test } from '@playwright/test'
import { gotoApp } from './helpers'

test('Python tab shows loading UI immediately then resolves to a result', async ({ page }) => {
  await gotoApp(page)

  const panel = page.locator('#result-python')
  const loading = page.getByTestId('loading-python')

  await expect(panel).toHaveAttribute('data-state', 'collapsed')

  const t0 = Date.now()
  await page.getByTestId('load-python').click()
  await expect(panel).toHaveAttribute('data-state', 'loading', { timeout: 1_000 })
  const elapsed = Date.now() - t0

  await expect(loading).toBeVisible()
  await expect(loading).toHaveAttribute('aria-busy', 'true')
  expect(elapsed, `loading UI must appear well before the multi-second load finishes (was ${elapsed}ms)`).toBeLessThan(2_000)

  await expect(panel).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
  await expect(page.locator('#output-python')).not.toHaveText('—')
  await expect(page.locator('#status-python')).toContainText('ok')
})
