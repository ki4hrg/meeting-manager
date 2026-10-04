import { expect, test } from '@playwright/test'

test('the time zone is offered from the browser and saved', async ({ page }) => {
  await page.goto('/settings')
  const zone = page.getByLabel('Time zone')
  await expect(zone).toHaveValue('America/Chicago')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel('Time zone')).toHaveValue('America/Chicago')
})
