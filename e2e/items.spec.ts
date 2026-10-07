import { expect, test } from '@playwright/test'
import { watchErrors } from './helpers'
import { WORLD } from './world'

const section = (page: import('@playwright/test').Page, title: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: false }) })

test('a question asked of no one in particular waits on home, and every item is on the Items page', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  const asked = section(page, 'Waiting on').getByRole('link').filter({ hasText: WORLD.items.delegateCost })
  await expect(asked).toBeVisible()
  await expect(asked.getByRole('img', { name: 'No one in particular' })).toBeVisible()

  await page.goto('/items')
  await expect(section(page, 'Questions').getByText(WORLD.items.delegateCost)).toBeVisible()
  await expect(section(page, 'Topics').getByText(WORLD.items.accountability)).toBeVisible()

  // Waiting on: the question, not what I owe.
  await page.getByRole('main').getByRole('link', { name: 'Waiting on' }).click()
  await expect(page).toHaveURL(/role=waiting/)
  await expect(page.getByText(WORLD.items.delegateCost)).toBeVisible()
  await expect(page.getByText(WORLD.items.overdue)).toHaveCount(0)

  // Search, keeping the chip; then the chip again clears it.
  await page.getByRole('searchbox', { name: 'Search' }).fill('chairs')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/q=chairs/)
  await expect(page.getByText(WORLD.items.delegateCost)).toHaveCount(0)
  await page.getByRole('main').getByRole('link', { name: 'Waiting on' }).click()
  await expect(page.getByText(WORLD.items.overdue)).toBeVisible()
  expect(errors).toEqual([])
})
