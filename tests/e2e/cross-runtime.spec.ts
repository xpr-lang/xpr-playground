import { expect, test } from '@playwright/test'
import { activateRuntime, gotoApp, loadExample, outputText } from './helpers'

const MATCHING_EXAMPLES = ['map', 'filter', 'reduce'] as const

test('the same expression yields byte-identical output across JS, Python and Go', async ({ page }) => {
  await gotoApp(page)
  await activateRuntime(page, 'python')
  await activateRuntime(page, 'go')

  for (const key of MATCHING_EXAMPLES) {
    await loadExample(page, key)

    await expect
      .poll(
        async () => {
          const [js, py, go] = await Promise.all([
            outputText(page, 'js'),
            outputText(page, 'python'),
            outputText(page, 'go'),
          ])
          const settled = js !== '—' && py !== '—' && go !== '—'
          return settled && js === py && py === go ? js : null
        },
        { message: `runtimes did not converge for example "${key}"`, timeout: 20_000 }
      )
      .not.toBeNull()
  }
})
