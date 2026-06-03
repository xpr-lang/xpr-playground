import { expect, test } from '@playwright/test'

test('page loads, default example auto-evaluates in JS, console is clean', async ({ page }) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })

  await page.goto('/')

  await expect(page.locator('#expr-editor .cm-content')).toBeVisible()
  await expect(page.locator('#output-js')).toContainText('Widget')
  await expect(page.locator('#status-js')).toContainText('ok')

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([])
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
})
