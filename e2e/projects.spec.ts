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

test('an answered question is recorded on a project with its answer', async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('link').filter({ hasText: WORLD.projects.worship }).first().click()
  const answered = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Answered/ }) })
  await answered.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog(page).getByLabel('Question').fill('Who plays the organ?')
  await dialog(page).getByLabel('Answer').fill('The cathedral organist')
  await dialog(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(answered.getByText('Who plays the organ?')).toBeVisible()
  await expect(answered.getByText('The cathedral organist')).toBeVisible()
})

test('sub-projects sit inside their top-level project, and fold away', async ({ page }) => {
  await page.goto('/projects')
  const year = page.getByRole('link').filter({ hasText: WORLD.projects.year })
  const worship = page.getByRole('link').filter({ hasText: WORLD.projects.worship })
  await expect(year).toBeVisible()
  await expect(worship).toBeVisible()

  await page.getByRole('button', { name: 'Collapse' }).first().click()
  await expect(year).toHaveCount(0)
  await expect(worship).toHaveCount(0)

  await page.reload()
  await expect(worship).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand' }).click()
  await expect(worship).toBeVisible()
})
