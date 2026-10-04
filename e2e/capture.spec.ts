import { expect, test } from '@playwright/test'
import { dialog } from './helpers'

test('a line typed in quick-add lands in the Inbox, and the box is ready for the next', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  const text = `Book the parish hall for the dinner ${Date.now()}`
  const line = dialog(page).getByLabel('New item')
  await line.fill(`A: ${text}`)
  await line.press('Enter')
  // It stays open for the next line.
  await expect(line).toHaveValue('')

  await page.goto('/inbox')
  await expect(page.getByText(text)).toBeVisible()
})
