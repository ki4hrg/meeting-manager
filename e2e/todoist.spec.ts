import { expect, test } from '@playwright/test'
import { watchErrors } from './helpers'
import { EXISTING_TASKS } from './todoist'
import { WORLD } from './world'

test('items open when Todoist was connected are matched to tasks John has, or skipped', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: /^Todoist/ })).toBeVisible()
  await expect(page.getByText('john@example.test', { exact: true })).toBeVisible()
  const match = page.getByRole('heading', { name: /^Match/ })
  await expect(match).toBeVisible()

  const row = (text: string) =>
    page.locator('div.flex.items-start').filter({ has: page.getByRole('link').filter({ hasText: text }) }).last()

  // The likeliest task is offered first, and linking takes the item out of Match.
  await row(WORLD.items.lunch).getByRole('button', { name: 'Link to a Todoist task' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: EXISTING_TASKS[0] })).toBeChecked()
  await dialog.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(page.getByRole('link').filter({ hasText: WORLD.items.lunch })).toHaveCount(0)

  await row(WORLD.items.overdue).getByRole('button', { name: "Don't send to Todoist" }).click()
  await expect(page.getByRole('link').filter({ hasText: WORLD.items.overdue })).toHaveCount(0)
  expect(errors).toEqual([])
})
