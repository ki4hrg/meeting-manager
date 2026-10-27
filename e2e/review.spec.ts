import { expect, test } from '@playwright/test'
import { dialog, selectContext, selectedContext } from './helpers'
import { WORLD } from './world'

test('a proposal waiting in another context is reviewed from home and accepted', async ({ page }) => {
  await page.goto('/')
  const review = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Review/ }) })
  await review.getByRole('link').filter({ hasText: WORLD.meetings.finance }).click()
  await expect(page).toHaveURL(/\/review$/)
  expect(await selectedContext(page)).toBe(WORLD.contexts.church)

  await expect(page.getByText(WORLD.proposal)).toBeVisible()

  // Someone else who was there comes in as here, and stays here when confirmed again (#41).
  const attendance = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Attendance' }) })
  await attendance.getByLabel('Also here').fill(WORLD.people.bishop)
  await attendance.getByRole('option', { name: WORLD.people.bishop }).click()
  await attendance.getByRole('button', { name: 'Confirm', exact: true }).click()
  const bishop = attendance.getByRole('button', { name: WORLD.people.bishop })
  await expect(bishop).toHaveAttribute('aria-pressed', 'true')
  await attendance.getByRole('button', { name: 'Confirm', exact: true }).click()
  await page.reload()
  await expect(bishop).toHaveAttribute('aria-pressed', 'true')

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

  // Accepting fixes nothing: who was there can still be corrected, a tap at a time.
  await bishop.click()
  await expect(bishop).toHaveAttribute('aria-pressed', 'false')
  await expect(bishop).toHaveAccessibleName(/^Out/)
  await attendance.getByLabel('Also here').fill(WORLD.people.adlene)
  await attendance.getByRole('option', { name: WORLD.people.adlene }).click()
  await attendance.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(attendance.getByRole('button', { name: WORLD.people.adlene })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(bishop).toHaveAccessibleName(/^Out/)

  // Nothing of it is left waiting on home.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: WORLD.meetings.finance })).toHaveCount(0)
})

test('a proposal accepted as a project from its kind, with a topic kept on it, and undone', async ({ page }) => {
  await selectContext(page, WORLD.contexts.conference)
  const review = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Review/ }) })
  await review.getByRole('link').filter({ hasText: WORLD.meetings.camps }).click()
  await expect(page).toHaveURL(/\/review$/)
  await expect(page.getByText(WORLD.projectProposal)).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await dialog(page).getByLabel('Kind').selectOption('project')
  await expect(dialog(page).getByLabel('Status')).toHaveValue('proposed')
  // The people are the kept topic's, so they show only with it.
  await expect(dialog(page).getByText('Raise with')).toBeHidden()
  await dialog(page).getByLabel('Keep a topic for it').check()
  await expect(dialog(page).getByText('Raise with')).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  await expect(page.getByRole('link', { name: WORLD.projectProposal })).toHaveAttribute('href', /\/projects\//)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
  await page.goto('/projects')
  await expect(page.getByRole('link').filter({ hasText: WORLD.projectProposal })).toHaveCount(0)
})
