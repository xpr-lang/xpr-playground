import { expect, test } from '@playwright/test'
import { gotoApp } from './helpers'

function colorScheme(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
}

test.describe('theme toggle', () => {
  test.use({ colorScheme: 'light' })

  test('toggling theme persists across reload', async ({ page }) => {
    await gotoApp(page)
    expect(await colorScheme(page)).toBe('light')

    await page.getByTestId('theme-toggle').click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await colorScheme(page)).toBe('dark')
    expect(await page.evaluate(() => localStorage.getItem('xpr-theme'))).toBe('dark')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await colorScheme(page)).toBe('dark')
  })
})

test.describe('system preference (no stored choice)', () => {
  test.describe('prefers dark', () => {
    test.use({ colorScheme: 'dark' })
    test('renders dark', async ({ page }) => {
      await gotoApp(page)
      expect(await page.evaluate(() => localStorage.getItem('xpr-theme'))).toBeNull()
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
      expect(await colorScheme(page)).toBe('dark')
    })
  })

  test.describe('prefers light', () => {
    test.use({ colorScheme: 'light' })
    test('renders light', async ({ page }) => {
      await gotoApp(page)
      expect(await colorScheme(page)).toBe('light')
    })
  })
})
