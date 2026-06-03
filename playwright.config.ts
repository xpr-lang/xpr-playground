import { defineConfig, devices } from '@playwright/test'

// W5.1 smoke suite. Tests run against the local Vite dev server, never the
// deployed pages.dev URL: dev serves public/ assets (Pyodide vendor wheel,
// xpr-go.wasm) same-origin with no CDN, matching how the runtimes load in prod.
// mobile.spec.ts runs only on the 375x667 projects; the side-by-side panel
// assertions in the other specs assume the desktop (>=1024px) CSS branch.
const DESKTOP_VIEWPORT = { width: 1280, height: 800 }
const MOBILE_VIEWPORT = { width: 375, height: 667 }

export default defineConfig({
  testDir: './tests/e2e',
  // Pyodide/Go boot is multi-second; give each test room without masking hangs.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Heavy runtimes (Pyodide) make many parallel workers memory-hungry; cap on CI.
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['line'],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: DESKTOP_VIEWPORT },
      // Firefox skips the Pyodide-backed specs (cross-runtime/divergence/python-load)
      // ONLY: under Playwright-on-Linux CI, concurrent 9.6MB Pyodide WASM instances
      // starve the bundled firefox nondeterministically (a spec passes one run and
      // fails the next with no code change). Blink (chromium) + WebKit cover those
      // specs cross-engine, and `bun run test:cross-runtime` proves all-runtime
      // byte-equivalence headlessly. Firefox still runs every non-Pyodide spec.
      testIgnore: /(mobile|cross-runtime|divergence|python-load)\.spec\.ts/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: DESKTOP_VIEWPORT },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Desktop Chrome'], viewport: MOBILE_VIEWPORT, hasTouch: true },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile-webkit',
      use: { ...devices['Desktop Safari'], viewport: MOBILE_VIEWPORT, hasTouch: true },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
})
