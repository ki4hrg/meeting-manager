import { expect, type Page } from '@playwright/test'

/** The selected context, as the switcher in the top bar shows it. */
export async function selectedContext(page: Page): Promise<string> {
  return (await page.locator('select[aria-label=Context] option:checked').textContent()) ?? ''
}

/** Select a context through the switcher, from home. */
export async function selectContext(page: Page, name: string) {
  await page.goto('/')
  if ((await selectedContext(page)) === name) return
  await page.locator('select[aria-label=Context]').selectOption({ label: name })
  await expect.poll(() => selectedContext(page)).toBe(name)
}

/** Fail the test on any uncaught error in the page. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** The open modal: there is only ever one. */
export const dialog = (page: Page) => page.locator('dialog[open]')
