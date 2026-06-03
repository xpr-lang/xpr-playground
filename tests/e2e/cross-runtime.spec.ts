import { expect, test } from '@playwright/test'
import { activateRuntime, gotoApp, loadExample, outputText } from './helpers'

const MATCHING_EXAMPLES = ['map', 'filter', 'reduce'] as const

// Locked Decision #9 terminates the Python/Go worker after every eval, so each
// loadExample() pays a fresh cold Pyodide boot (download + instantiate the 9.6MB
// wasm + micropip-install the wheel, up to PythonRuntime's 30s INIT_TIMEOUT) before
// the new result can appear. Under CI's 2 concurrent Playwright workers that boot
// routinely exceeds 20s on firefox/webkit, so the convergence ceiling must out-wait
// a worst-case per-example reboot (boot + 5s eval + margin) and the whole test must
// budget one reboot per example. These are ceilings, not fixed waits, so healthy
// runs still settle in seconds. Exhaustive 16-example byte-equivalence is covered
// headlessly by `bun run test:cross-runtime`; this spec only proves the UI wires all
// three runtimes to the same output.
const CONVERGE_TIMEOUT_MS = 45_000

test('the same expression yields byte-identical output across JS, Python and Go', async ({ page }) => {
  test.setTimeout(240_000)
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
