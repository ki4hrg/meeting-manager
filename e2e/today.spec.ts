import { expect, test } from '@playwright/test'
import { selectedContext, watchErrors } from './helpers'
import { WORLD } from './world'

const section = (page: import('@playwright/test').Page, title: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: false }) })

test('home lists what needs attention in every context, each row marked with its own', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  expect(await selectedContext(page)).toBe(WORLD.contexts.conference)

  const due = section(page, 'Due')
  await expect(due.getByText(WORLD.items.overdue)).toBeVisible()
  await expect(due.getByTitle(WORLD.contexts.conference).or(due.getByText(WORLD.contexts.conference)).first()).toBeVisible()

  // From the other context, and saying so.
  const owe = section(page, 'I owe')
  const lunch = owe.getByRole('link').filter({ hasText: WORLD.items.lunch })
  await expect(lunch).toBeVisible()
  await expect(lunch.getByText(WORLD.contexts.church)).toBeVisible()
  await expect(section(page, 'Waiting on').getByText(WORLD.items.bulletin)).toBeVisible()
  await expect(section(page, 'Next up').getByText(WORLD.meetings.checkIn)).toBeVisible()
  expect(errors).toEqual([])
})

test('opening a row from another context selects that context on the way', async ({ page }) => {
  await page.goto('/')
  await section(page, 'I owe').getByRole('link').filter({ hasText: WORLD.items.lunch }).click()
  await expect(page).toHaveURL(/\/items\//)
  await expect(page.getByRole('heading', { name: WORLD.items.lunch })).toBeVisible()
  expect(await selectedContext(page)).toBe(WORLD.contexts.church)
})

test('quick-add names the context it files into', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await expect(page.locator('dialog[open]').getByText(WORLD.contexts.conference)).toBeVisible()
})
