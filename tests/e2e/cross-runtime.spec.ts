import { expect, test } from '@playwright/test'
import { activateRuntime, gotoApp, loadExample, outputText } from './helpers'

// One representative pipeline proves the UI wires all three runtimes to the same
// output; exhaustive 16-example byte-equivalence across JS/Python/Go is covered
// headlessly by `bun run test:cross-runtime`. The 45s poll is a ceiling (not a
// fixed wait) that out-waits one cold Pyodide reboot: Locked Decision #9 terminates
// the Python/Go worker after every eval, so loadExample() re-pays Pyodide's boot
// (instantiate the 9.6MB wasm + micropip-install the wheel, up to its 30s
// INIT_TIMEOUT) before the result appears. Runs on chromium + webkit only; see the
// firefox project's testIgnore in playwright.config.ts for why firefox is excluded.
const MATCHING_EXAMPLES = ['map'] as const
const CONVERGE_TIMEOUT_MS = 45_000

test('the same expression yields byte-identical output across JS, Python and Go', async ({ page }) => {
  test.setTimeout(150_000)
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
        { message: `runtimes did not converge for example "${key}"`, timeout: CONVERGE_TIMEOUT_MS }
      )
      .not.toBeNull()
  }
})
