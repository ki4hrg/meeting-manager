import { expect, test } from '@playwright/test'
import { selectContext, watchErrors } from './helpers'
import { WORLD } from './world'

const crumbs = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Breadcrumb' })

test("breadcrumbs lead back the way you came: a person's project action goes back to the person", async ({ page }) => {
  const errors = watchErrors(page)
  await selectContext(page, WORLD.contexts.conference)
  await page.goto('/people')
  await page.getByRole('link').filter({ hasText: WORLD.people.adlene }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.people.adlene, exact: true })).toBeVisible()
  const person = page.url()

  await page.getByRole('link').filter({ hasText: WORLD.items.venue }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.items.venue })).toBeVisible()
  await expect(crumbs(page).getByRole('link')).toHaveText(['People', WORLD.people.adlene])

  // A refresh keeps the way back.
  await page.reload()
  await expect(crumbs(page).getByRole('link')).toHaveText(['People', WORLD.people.adlene])

  await crumbs(page).getByRole('link', { name: WORLD.people.adlene }).click()
  await expect(page).toHaveURL(person)
  await expect(page.getByRole('heading', { name: WORLD.people.adlene, exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('opened directly, a page shows where it lives', async ({ page }) => {
  await selectContext(page, WORLD.contexts.conference)
  await page.goto('/people')
  await page.getByRole('link').filter({ hasText: WORLD.people.adlene }).first().click()
  const href = await page.getByRole('link').filter({ hasText: WORLD.items.venue }).first().getAttribute('href')
  await page.goto(href!.split('?')[0]!)
  await expect(crumbs(page).getByRole('link')).toHaveText(['Projects', WORLD.projects.year])

  // A `from` that is not one of the app's pages is ignored.
  await page.goto(`${href!.split('?')[0]}?from=${encodeURIComponent('https://evil.example/')}`)
  await expect(crumbs(page).getByRole('link')).toHaveText(['Projects', WORLD.projects.year])
})
