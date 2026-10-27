import { expect, test } from '@playwright/test'
import { dialog } from './helpers'

test('a logged meeting turns its D: line into a proposal to review', async ({ page }) => {
  await page.goto('/meetings')
  await page.getByRole('button', { name: 'Log', exact: true }).click()
  await dialog(page).getByLabel('Notes').fill('Talked through the room.\nD: Keep the Thursday slot')
  await dialog(page).getByRole('button', { name: 'Log', exact: true }).click()

  // Log opens the meeting's review; the run is kicked once the response has gone.
  await expect(page).toHaveURL(/#review$/)
  await expect(async () => {
    await page.reload()
    await expect(page.getByText('Keep the Thursday slot')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  await expect(page.getByTitle('Verbatim')).toBeVisible()
})

test('a name nobody matches is settled from the edit form, as a new person', async ({ page }) => {
  await page.goto('/meetings')
  await page.getByRole('button', { name: 'Log', exact: true }).click()
  await dialog(page).getByLabel('Notes').fill('A: Book the hall @Priya')
  await dialog(page).getByRole('button', { name: 'Log', exact: true }).click()

  await expect(page).toHaveURL(/#review$/)
  await expect(async () => {
    await page.reload()
    await expect(page.getByText('Book the hall', { exact: true })).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })

  await page.locator('#review').getByRole('button', { name: 'Edit', exact: true }).first().click()
  await dialog(page).getByRole('listbox', { name: 'Who is Priya?' }).getByRole('option', { name: 'New person Priya' }).click()
  await dialog(page).getByLabel("New person's name").fill('Priya Patel')
  await expect(dialog(page).getByRole('listbox', { name: 'Who is Priya?' })).toBeHidden()
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Who is Priya?' })).toHaveCount(0)
})
