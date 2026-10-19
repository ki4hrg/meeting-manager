import { expect, test } from '@playwright/test'
import { dialog, selectContext } from './helpers'
import { WORLD } from './world'

test('someone not yet in the directory is added to an item as who it is for', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link').filter({ hasText: WORLD.items.overdue }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.items.overdue })).toBeVisible()

  await page.getByRole('button', { name: 'For: add', exact: true }).click()
  // Only a first name to go on: picked as a new person, and completed before it is made.
  await dialog(page).getByLabel('Person or group').fill('Neil')
  await dialog(page).getByRole('option', { name: 'New person Neil' }).click()
  await dialog(page).getByLabel("New person's name").fill('Neil Carter')
  await dialog(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  // An action points at who it is for.
  await expect(page.getByTitle('For').filter({ hasText: 'Neil Carter' })).toBeVisible()

  // From the chip, Neil changes role in place: he joins as a collaborator, then is for it again.
  await page.getByRole('button', { name: 'For: change' }).click()
  await page.getByRole('menuitem', { name: 'With', exact: true }).click()
  await expect(page.getByTitle('With').filter({ hasText: 'Neil Carter' })).toBeVisible()
  await page.getByRole('button', { name: 'With: change' }).click()
  await page.getByRole('menuitem', { name: 'For', exact: true }).click()
  await expect(page.getByTitle('For').filter({ hasText: 'Neil Carter' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: /^Role/ })).toHaveCount(2)
  await page.goto('/people')
  await expect(page.getByText('Neil Carter')).toBeVisible()
})

test('a new group is made from the name picked for an item', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link').filter({ hasText: WORLD.items.overdue }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.items.overdue })).toBeVisible()

  await page.getByRole('button', { name: 'With: add', exact: true }).click()
  await dialog(page).getByLabel('Person or group').fill('Wardens')
  await dialog(page).getByRole('option', { name: 'New group Wardens' }).click()
  await dialog(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  await expect(page.getByTitle('With').filter({ hasText: 'Wardens' })).toBeVisible()
})

test("a recap's prose is reworded by hand, and the edit can be undone", async ({ page }) => {
  await selectContext(page, WORLD.contexts.church)
  await page.goto('/meetings/past')
  await page.getByRole('link').filter({ hasText: WORLD.meetings.finance }).first().click()
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}/)
  const meeting = /\/meetings\/[0-9a-f-]{36}/.exec(page.url())![0]
  await page.goto(`${meeting}/recap`)
  await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await dialog(page).getByLabel('Summary').fill('We agreed to replace the boiler before winter.')
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('paragraph').filter({ hasText: 'We agreed to replace the boiler before winter.' })).toBeVisible()

  await page.getByRole('button', { name: 'Undo edits', exact: true }).click()
  await expect(page.getByRole('paragraph').filter({ hasText: 'We agreed to replace the boiler before winter.' })).toHaveCount(0)
})
