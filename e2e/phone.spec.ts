import { expect, test } from '@playwright/test'
import { watchErrors } from './helpers'
import { WORLD } from './world'

const PAGES = ['/', '/inbox', '/meetings', '/meetings/past', '/projects', '/people', '/groups', '/series', '/settings', '/design']

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

    test('an item page fits the screen, its title the full width', async ({ page }) => {
      const errors = watchErrors(page)
      await page.goto('/')
      await page.waitForLoadState('networkidle')
      await page.getByRole('link').filter({ hasText: WORLD.items.overdue }).first().click()
      const title = page.getByRole('heading', { name: WORLD.items.overdue })
      await expect(title).toBeVisible()
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0)
      const widths = await title.evaluate((h1) => ({ title: h1.clientWidth, column: h1.parentElement!.clientWidth }))
      expect(widths.title, 'badges squeeze the title').toBeGreaterThanOrEqual(widths.column - 1)
      expect(errors).toEqual([])
    })
  })
}
