import { expect, test } from '@playwright/test'
import { selectContext, selectedContext } from './helpers'
import { WORLD } from './world'

const switchTo = async (page: import('@playwright/test').Page, name: string) => {
  await page.locator('select[aria-label=Context]').selectOption({ label: name })
  await expect.poll(() => selectedContext(page)).toBe(name)
}

test('switching context keeps the page, and leaves a record of the old one for its list', async ({ page }) => {
  await selectContext(page, WORLD.contexts.conference)

  await page.goto('/projects')
  await switchTo(page, WORLD.contexts.church)
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole('link').filter({ hasText: WORLD.projects.standing })).toHaveCount(0)

  await switchTo(page, WORLD.contexts.conference)
  await expect(page).toHaveURL(/\/projects$/)
  await page.getByRole('link').filter({ hasText: WORLD.projects.standing }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.projects.standing, exact: true })).toBeVisible()

  await switchTo(page, WORLD.contexts.church)
  await expect(page).toHaveURL(/\/projects$/)
})

test('the switcher lists contexts only; Contexts and Settings are in the account menu', async ({ page }) => {
  await page.goto('/')
  const options = page.locator('select[aria-label=Context] option')
  await expect(options.filter({ hasText: /Contexts|Settings/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Account menu' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Contexts', 'Settings', 'Sign out'])
  await page.getByRole('menuitem', { name: 'Contexts' }).click()
  await expect(page).toHaveURL(/\/contexts$/)

  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)
})
