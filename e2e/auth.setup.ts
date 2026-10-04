import { expect, test as setup } from '@playwright/test'
import { ACCOUNT } from './world'

setup('sign in', async ({ page }) => {
  await page.goto('/login')
  await page.locator('[name=email]').fill(ACCOUNT.email)
  await page.locator('[name=password]').fill(ACCOUNT.password)
  await page.locator('button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible()
  await page.context().storageState({ path: 'e2e/.auth/john.json' })
})
