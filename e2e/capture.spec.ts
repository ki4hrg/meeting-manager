import { expect, test } from '@playwright/test'
import { dialog, openQuickAdd } from './helpers'

test('a line typed in quick-add lands in the Inbox, and the box is ready for the next', async ({ page }) => {
  await page.goto('/')
  await openQuickAdd(page)
  const text = `Book the parish hall for the dinner ${Date.now()}`
  const line = dialog(page).getByLabel('New item')
  await line.fill(`A: ${text}`)
  await line.press('Enter')
  // It stays open for the next line.
  await expect(line).toHaveValue('')

  await page.goto('/inbox')
  await expect(page.getByText(text)).toBeVisible()
})

test('a name that matches nobody is made a new person with the line', async ({ page }) => {
  await page.goto('/')
  await openQuickAdd(page)
  const box = dialog(page)
  const line = box.getByLabel('New item')

  // Typed in full and entered: refused, with the fix offered in place.
  const text = `Budget timing ${Date.now()}`
  await line.fill(`Q: ${text} @Neil-Campbell`)
  await line.press('Enter')
  await expect(box.getByText('No person, group, project or series matches Neil-Campbell.')).toBeVisible()
  await box.getByRole('option', { name: 'New person Neil Campbell' }).click()
  const name = box.getByLabel('Name for @Neil-Campbell')
  await expect(name).toHaveValue('Neil Campbell')
  await name.fill('Neil McCampbell')
  await line.press('Enter')
  await expect(line).toHaveValue('')

  // Owned by them, so on their page rather than in the Inbox.
  await page.goto('/people')
  await page.getByRole('link', { name: /Neil McCampbell/ }).first().click()
  await expect(page.getByText(text)).toBeVisible()
})
