import { expect, test } from '@playwright/test'
import { dialog } from './helpers'
import { WORLD } from './world'

test("pausing a project offers to pause its sub-projects, and does only when asked", async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('link').filter({ hasText: WORLD.projects.standing }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.projects.standing, exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await dialog(page).getByLabel('Status').selectOption('paused')
  await dialog(page).getByLabel('Also pause 2 sub-projects').check()
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  await page.goto('/projects')
  await expect(page.getByText('Paused')).toHaveCount(3)
})
