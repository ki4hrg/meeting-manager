import { expect, test } from '@playwright/test'
import { WORLD } from './world'

test('prepping a meeting with someone places what is waiting for them', async ({ page }) => {
  await page.goto('/people')
  await page.getByRole('link').filter({ hasText: WORLD.people.adlene }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.people.adlene })).toBeVisible()
  await page.getByRole('button', { name: 'Prep', exact: true }).click()

  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/)
  await expect(page.getByText(WORLD.items.accountability).first()).toBeVisible()
})
