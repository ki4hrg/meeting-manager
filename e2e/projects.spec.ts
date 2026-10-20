import { expect, test } from '@playwright/test'
import { dialog, selectContext } from './helpers'
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

test('a topic becomes a proposed project, listed apart on its parent until agreed to', async ({ page }) => {
  await selectContext(page, WORLD.contexts.conference)
  await page.goto('/projects')
  await page.getByRole('link').filter({ hasText: WORLD.projects.year }).first().click()
  const topics = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Topics/ }) })
  await topics.getByRole('link').filter({ hasText: WORLD.items.policy }).click()

  await page.getByRole('button', { name: 'Make project', exact: true }).click()
  await expect(dialog(page).getByLabel('Name')).toHaveValue(WORLD.items.policy)
  await expect(dialog(page).getByLabel('Within').locator('option:checked')).toHaveText(new RegExp(WORLD.projects.year))
  await expect(dialog(page).getByLabel('Status')).toHaveValue('proposed')
  await expect(dialog(page).getByLabel('Close the topic')).not.toBeChecked()
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()

  await expect(page.getByRole('heading', { name: WORLD.items.policy, exact: true })).toBeVisible()
  await expect(page.getByText('Proposed', { exact: true }).first()).toBeVisible()
  // The topic came along, still open: the next thing to raise about it.
  const moved = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Topics/ }) })
  await expect(moved.getByText(WORLD.items.policy)).toBeVisible()

  await page.getByRole('link', { name: WORLD.projects.year }).first().click()
  const proposed = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Proposed/ }) })
  await expect(proposed.getByRole('link').filter({ hasText: WORLD.items.policy })).toBeVisible()
  const subProjects = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Sub-projects/ }) })
  await expect(subProjects.getByRole('link').filter({ hasText: WORLD.items.policy })).toHaveCount(0)
})
