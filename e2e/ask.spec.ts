import { expect, test } from '@playwright/test'
import { dialog, selectContext, watchErrors } from './helpers'
import { WORLD } from './world'

test('a question for the bishop is asked, answered with a decision, and reported at the next planning meeting', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await selectContext(page, WORLD.contexts.conference)

  // Asked through an action of John's, in the question's thread.
  await page.goto('/items')
  await page.getByRole('link').filter({ hasText: WORLD.items.scripture }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.items.scripture })).toBeVisible()
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  const ask = `Ask ${WORLD.people.bishop}: ${WORLD.items.scripture}`
  await expect(page.getByRole('link', { name: ask }).first()).toBeVisible()

  // Sent: ticking the ask brings the question back.
  await page.getByRole('link', { name: ask }).first().click()
  await expect(page.getByRole('heading', { name: ask })).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('link', { name: WORLD.items.scripture }).first().click()

  // His answer comes back by email, and is worth keeping as a decision.
  await page.getByRole('button', { name: 'Answer', exact: true }).click()
  await dialog(page).getByLabel('Answer').fill('Micah 6:8')
  await dialog(page).getByLabel('Decision').fill('Closing worship ends on Micah 6:8')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toHaveCount(0)

  // The planning team hears it at its next meeting.
  await page.goto('/meetings')
  await page.getByRole('link').filter({ hasText: WORLD.meetings.planning }).first().click()
  await expect(page.getByText('Closing worship ends on Micah 6:8')).toBeVisible()

  // The question left to mention in person comes up when he is there.
  await page.goto('/meetings')
  await page.getByRole('link').filter({ hasText: WORLD.meetings.bishop }).first().click()
  await page.locator('summary').filter({ hasText: 'Suggestions' }).click()
  await expect(page.getByText(WORLD.items.longForm)).toBeVisible()
  // His to answer: under him, with what is owed to John.
  await expect(page.getByText('To me', { exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})
