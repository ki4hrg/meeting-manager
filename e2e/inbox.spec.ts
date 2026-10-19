import { expect, test } from '@playwright/test'
import { selectContext, selectedContext, watchErrors } from './helpers'
import { WORLD } from './world'

test("the Inbox lists another context's items, marked with it, and opens them there", async ({ page }) => {
  const errors = watchErrors(page)
  await selectContext(page, WORLD.contexts.conference)
  await page.goto('/inbox')
  const row = page.getByRole('link').filter({ hasText: WORLD.items.loose })
  await expect(row).toBeVisible()
  await expect(row.getByText(WORLD.contexts.church)).toBeVisible()
  expect(await selectedContext(page)).toBe(WORLD.contexts.conference)

  await row.click()
  await expect(page.getByRole('heading', { name: WORLD.items.loose })).toBeVisible()
  expect(await selectedContext(page)).toBe(WORLD.contexts.church)
  expect(errors).toEqual([])
})
