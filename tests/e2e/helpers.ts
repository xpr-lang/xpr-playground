import { expect, type Page } from '@playwright/test'

export type Runtime = 'js' | 'python' | 'go'

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#expr-editor .cm-content')).toBeVisible()
}

// CodeMirror is a contenteditable, so fill()/keyboard typing fight bracket
// auto-close. A single execCommand('insertText') after select-all arrives as one
// beforeinput, which CodeMirror applies as one transaction with no per-key
// bracket completion (the technique proven in the W3.5 notepad).
export async function setEditor(page: Page, mount: string, text: string): Promise<void> {
  await page.locator(`${mount} .cm-content`).click()
  await page.evaluate(
    ({ mount, text }) => {
      const cm = document.querySelector(`${mount} .cm-content`) as HTMLElement | null
      if (!cm) throw new Error(`missing editor ${mount}`)
      cm.focus()
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(cm)
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.execCommand('insertText', false, text)
    },
    { mount, text }
  )
}

export const setExpr = (page: Page, text: string): Promise<void> => setEditor(page, '#expr-editor', text)
export const setCtx = (page: Page, text: string): Promise<void> => setEditor(page, '#ctx-editor', text)

// CodeMirror renders one .cm-line per logical line and block divs add no newline
// to textContent, so reconstruct the document by joining the lines.
export function readEditor(page: Page, mount: string): Promise<string> {
  return page.evaluate((mount) => {
    const lines = document.querySelectorAll(`${mount} .cm-line`)
    return Array.from(lines, (l) => l.textContent ?? '').join('\n')
  }, mount)
}

export const readExpr = (page: Page): Promise<string> => readEditor(page, '#expr-editor')
export const readCtx = (page: Page): Promise<string> => readEditor(page, '#ctx-editor')

export async function loadExample(page: Page, key: string): Promise<void> {
  await page.locator('#examples-select').selectOption(key)
}

// The mobile tabs are hidden by the desktop (>=1024px) CSS branch, so on the
// side-by-side desktop layout the in-panel "Click to load" button is the visible
// activation affordance. Both wire to the same RuntimeMatrix.activate().
export async function activateRuntime(page: Page, rt: Runtime, timeout = 30_000): Promise<void> {
  await page.getByTestId(`load-${rt}`).click()
  await expect(page.locator(`#result-${rt}`)).toHaveAttribute('data-state', 'ready', { timeout })
}

export function outputText(page: Page, rt: Runtime): Promise<string> {
  return page.locator(`#output-${rt}`).innerText()
}

// Replicates b64EncodeUtf8 from src/main.ts byte-for-byte so the test can mint
// authentic legacy v=1 (#e=&c=) share URLs and prove the decoder restores them.
export function b64EncodeUtf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

export function legacyV1Hash(expr: string, ctx: string): string {
  return `#e=${b64EncodeUtf8(expr)}&c=${b64EncodeUtf8(ctx)}`
}
