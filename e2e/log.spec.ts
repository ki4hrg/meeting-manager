import { expect, test } from '@playwright/test'
import { dialog } from './helpers'

test('a logged meeting turns its D: line into a proposal to review', async ({ page }) => {
  await page.goto('/meetings')
  await page.getByRole('button', { name: 'Log', exact: true }).click()
  await dialog(page).getByLabel('Notes').fill('Talked through the room.\nD: Keep the Thursday slot')
  await dialog(page).getByRole('button', { name: 'Log', exact: true }).click()

  // Log opens the meeting's review; the run is kicked once the response has gone.
  await expect(page).toHaveURL(/\/review$/)
  await expect(async () => {
    await page.reload()
    await expect(page.getByText('Keep the Thursday slot')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  await expect(page.getByTitle('Verbatim')).toBeVisible()
})
