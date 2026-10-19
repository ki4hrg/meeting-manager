import { expect, test } from '@playwright/test'
import { dialog, watchErrors } from './helpers'
import { WORLD } from './world'

test('an item waits in Later until another is done, and each end shows the other', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/people')
  await page.getByRole('link').filter({ hasText: WORLD.people.adlene }).first().click()
  await page.getByRole('link').filter({ hasText: WORLD.items.accountability }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.items.accountability })).toBeVisible()

  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await dialog(page).getByLabel('Until done').fill('agency meeting')
  await dialog(page).getByRole('option', { name: WORLD.items.overdue }).click()
  await dialog(page).getByRole('button', { name: 'Later', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  const waitsOn = page.getByRole('link', { name: WORLD.items.overdue })
  await expect(waitsOn).toBeVisible()
  await waitsOn.click()
  await expect(page.getByRole('heading', { name: WORLD.items.overdue })).toBeVisible()
  await expect(page.getByText('Waiting on this')).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: WORLD.items.accountability })).toBeVisible()

  // Back where it was, for the other journeys.
  await page.getByRole('link', { name: WORLD.items.accountability }).click()
  await page.getByRole('button', { name: 'Bring back now' }).click()
  await expect(page.getByRole('link', { name: WORLD.items.overdue })).toHaveCount(0)
  expect(errors).toEqual([])
})
