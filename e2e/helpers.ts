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

/* Open quick-add. A click before the page has hydrated does nothing, so it is
   clicked until the box is there. */
export async function openQuickAdd(page: Page) {
  const line = dialog(page).getByLabel('New item')
  await expect(async () => {
    // Not again once it is open: the button is behind it then.
    if (!(await line.isVisible())) await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await expect(line).toBeVisible({ timeout: 1_000 })
  }).toPass()
}
