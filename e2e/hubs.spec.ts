import { expect, test } from '@playwright/test'
import { dialog } from './helpers'
import { WORLD } from './world'

const section = (page: import('@playwright/test').Page, title: RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, level: 2 }) })

test('a hub puts its reference beside the work on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/projects')
  await page.getByRole('link').filter({ hasText: WORLD.projects.year }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.projects.year, exact: true })).toBeVisible()

  const owed = (await section(page, /^Owed/).first().boundingBox())!
  const milestones = (await section(page, /^Milestones/).boundingBox())!
  expect(milestones.x).toBeGreaterThan(owed.x + owed.width)
  expect(owed.width).toBeGreaterThan(milestones.width * 1.5)
})

test('an empty section is only its header, and its action still adds', async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('link').filter({ hasText: WORLD.projects.year }).first().click()

  const links = section(page, /^Links/)
  await expect(links).toHaveAttribute('data-empty')
  expect((await links.boundingBox())!.height).toBeLessThan(50)

  await links.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog(page).getByRole('textbox', { name: /^URL/ }).fill('https://example.test/plan')
  await dialog(page).getByRole('textbox', { name: /^Label/ }).fill('Plan')
  await dialog(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(links.getByRole('link', { name: 'Plan' })).toBeVisible()
  await expect(links).not.toHaveAttribute('data-empty')
})

test('a duplicate person is merged into the one kept', async ({ page }) => {
  await page.goto('/people')
  await page.getByRole('button', { name: 'New person' }).click()
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('S. Jones')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toHaveCount(0)

  await page.goto('/people')
  await page.getByRole('link').filter({ hasText: WORLD.people.sarah }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.people.sarah, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).click()
  await dialog(page).getByLabel(/^Duplicate/).selectOption({ label: 'S. Jones' })
  await dialog(page).getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  await page.goto('/people')
  await expect(page.getByText(WORLD.people.sarah)).toBeVisible()
  await expect(page.getByText('S. Jones')).toHaveCount(0)
})
