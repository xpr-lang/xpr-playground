import { expect, test } from '@playwright/test'
import { activateRuntime, gotoApp, loadExample, outputText } from './helpers'

// One representative pipeline proves the UI wires all three runtimes to the same
// output. Exhaustive 16-example byte-equivalence across JS/Python/Go is covered
// headlessly by `bun run test:cross-runtime`. A single example is deliberate:
// Locked Decision #9 terminates the Python/Go worker after every eval, so each
// loadExample() pays a fresh cold Pyodide boot (instantiate the 9.6MB wasm +
// micropip-install the wheel, up to PythonRuntime's 30s INIT_TIMEOUT); chaining
// several such reboots under CI's concurrent Playwright workers overruns firefox's
// budget, while a single boot matches what python-load.spec already passes there.
const MATCHING_EXAMPLES = ['map'] as const
// Ceiling, not a fixed wait, that out-waits one worst-case Pyodide reboot.
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
