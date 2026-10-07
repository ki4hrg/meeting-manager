import { expect, test } from '@playwright/test'
import { watchErrors } from './helpers'

const PAGES = ['/', '/inbox', '/items', '/meetings', '/meetings/past', '/projects', '/people', '/groups', '/series', '/settings', '/design']

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`at phone width, ${scheme}`, () => {
    test.use({ colorScheme: scheme })
    for (const path of PAGES) {
      test(`${path} fits the screen and runs clean`, async ({ page }) => {
        const errors = watchErrors(page)
        await page.goto(path)
        await page.waitForLoadState('networkidle')
        await expect(page.locator('main h1, main h2').first()).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0)
        expect(errors).toEqual([])
      })
    }
  })
}
