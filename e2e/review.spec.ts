import { expect, test } from '@playwright/test'
import { dialog, selectedContext } from './helpers'
import { WORLD } from './world'

test('a proposal waiting in another context is reviewed from home and accepted', async ({ page }) => {
  await page.goto('/')
  const review = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Review/ }) })
  await review.getByRole('link').filter({ hasText: WORLD.meetings.finance }).click()
  await expect(page).toHaveURL(/\/review$/)
  expect(await selectedContext(page)).toBe(WORLD.contexts.church)

  await expect(page.getByText(WORLD.proposal)).toBeVisible()
  // It names no owner or deadline, so Accept asks for them; both may stay empty.
  await page.getByRole('button', { name: 'Accept', exact: true }).first().click()
  await dialog(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()

  // Nothing of it is left waiting on home.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: WORLD.meetings.finance })).toHaveCount(0)
})
