import { expect, test } from '@playwright/test'

test('the browser’s time zone is saved without asking, and another can be picked', async ({ page }) => {
  await page.goto('/settings')
  const zone = page.getByLabel('Time zone')
  await expect(zone).toHaveValue('America/Chicago')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)

  await zone.selectOption('America/New_York')
  await expect(zone).toBeEnabled()
  await page.reload()
  await expect(page.getByLabel('Time zone')).toHaveValue('America/New_York')

  await page.getByLabel('Time zone').selectOption('America/Chicago')
  await expect(page.getByLabel('Time zone')).toBeEnabled()
  await page.reload()
  await expect(page.getByLabel('Time zone')).toHaveValue('America/Chicago')
})
