import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// W5.3: axe-core only inspects rendered DOM, so sweep both responsive layouts
// (desktop 1280, mobile 375) x both themes (dark forced via emulateMedia). Viewport
// is set per-test because Playwright projects route by filename; serial mode keeps
// the shared `report` array in one worker so afterAll emits one evidence file.
test.describe.configure({ mode: 'serial' })

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

const VIEWPORTS = [
  { name: 'desktop-1280', width: 1280, height: 800 },
  { name: 'mobile-375', width: 375, height: 667 },
] as const

const SCHEMES = ['light', 'dark'] as const

type Scenario = {
  scenario: string
  violations: unknown[]
  passes: number
  incomplete: number
  inapplicable: number
}

const report: Scenario[] = []

async function loadPlayground(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme })
  await page.goto('/')
  await expect(page.locator('#expr-editor .cm-content')).toBeVisible()
  // The default "filter" example auto-evaluates in JS; audit the settled UI
  // (status reads "ok"), not the transient placeholder.
  await expect(page.locator('#status-js')).toContainText('ok', { timeout: 15_000 })
}

test.describe('WCAG 2.1 AA — loaded playground', () => {
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      test(`zero A/AA violations · ${vp.name} · ${scheme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await loadPlayground(page, scheme)

        const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze()

        const scenario = `${vp.name}-${scheme}`
        report.push({
          scenario,
          violations: results.violations,
          passes: results.passes.length,
          incomplete: results.incomplete.length,
          inapplicable: results.inapplicable.length,
        })
        await testInfo.attach(`axe-${scenario}.json`, {
          body: JSON.stringify(results, null, 2),
          contentType: 'application/json',
        })

        const summary = results.violations.map(
          (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.help} [${v.nodes.map((n) => n.target.join(' ')).join(' | ')}]`
        )
        expect(summary, `axe WCAG A/AA violations on ${scenario}`).toEqual([])
      })
    }
  }
})

test.afterAll(() => {
  const out = resolve(process.cwd(), '../.sisyphus/evidence/playground-v2/W5-3-axe-report.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(
    out,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), tags: WCAG_AA_TAGS, scenarios: report },
      null,
      2
    )
  )
})
