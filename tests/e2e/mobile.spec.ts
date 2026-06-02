import { expect, test } from '@playwright/test'
import { gotoApp, setExpr } from './helpers'

test('mobile layout is tabbed, single-panel, scroll-free and editable', async ({ page }) => {
  await gotoApp(page)

  await expect(page.locator('.runtime-tabs')).toBeVisible()

  expect(await page.locator('.result-panel:visible').count()).toBe(1)
  await expect(page.locator('#result-js')).toBeVisible()
  await expect(page.locator('#result-python')).toBeHidden()
  await expect(page.locator('#result-go')).toBeHidden()

  const overflow = await page.evaluate(() => {
    const el = document.documentElement
    return { scroll: el.scrollWidth, client: el.clientWidth }
  })
  expect(overflow.scroll, 'page must not scroll horizontally').toBeLessThanOrEqual(overflow.client + 1)

  await setExpr(page, '1 + 2')
  await expect(page.locator('#output-js')).toHaveText('3')

  await page.getByTestId('tab-go').click()
  await expect(page.locator('#result-go')).toBeVisible()
  await expect(page.locator('#result-js')).toBeHidden()
  expect(await page.locator('.result-panel:visible').count()).toBe(1)
})
