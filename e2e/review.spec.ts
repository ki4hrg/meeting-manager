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
  // Changing its kind relabels the people and keeps who is picked; a decision takes no deadline.
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await dialog(page).getByLabel('Assigned to', { exact: true }).fill(WORLD.people.sarah)
  await dialog(page).getByRole('option', { name: WORLD.people.sarah }).click()
  await expect(dialog(page).getByLabel('Due')).toBeVisible()
  await dialog(page).getByLabel('Kind').selectOption('question')
  await expect(dialog(page).getByLabel('Assigned to', { exact: true })).toBeHidden()
  await expect(dialog(page).getByLabel('Asked by', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('Answer needed from')).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: `Remove ${WORLD.people.sarah}` })).toBeVisible()
  await dialog(page).getByLabel('Kind').selectOption('decision')
  await expect(dialog(page).getByText('Decided by')).toBeVisible()
  await expect(dialog(page).getByLabel('Due')).toBeHidden()
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  // It names no owner or deadline, so Accept asks for them; both may stay empty.
  await page.getByRole('button', { name: 'Accept', exact: true }).first().click()
  await dialog(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()

  // Nothing of it is left waiting on home.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: WORLD.meetings.finance })).toHaveCount(0)
})
