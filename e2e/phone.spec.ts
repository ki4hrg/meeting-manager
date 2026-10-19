import { expect, test } from '@playwright/test'
import { dialog, watchErrors } from './helpers'
import { WORLD } from './world'

/* Signed out, so the page is not redirected past. */
const SIGNED_OUT = ['/login']

const PAGES = ['/', '/inbox', '/items', '/meetings', '/meetings/past', '/projects', '/people', '/groups', '/series', '/settings', '/design']

/* Hubs, reached from their list: a heading from the main column and one from the side. */
const HUBS = [
  { list: '/projects', name: WORLD.projects.year, main: 'Owed', side: 'Milestones' },
  { list: '/people', name: WORLD.people.adlene, main: 'Raise', side: 'Meetings' },
  { list: '/meetings', name: WORLD.meetings.checkIn, main: 'Agenda', side: 'Blocks' },
]

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`at phone width, ${scheme}`, () => {
    test.use({ colorScheme: scheme })
    test.describe('signed out', () => {
      test.use({ storageState: { cookies: [], origins: [] } })
      for (const path of SIGNED_OUT) {
        test(`${path} fits the screen and runs clean`, async ({ page }) => {
          const errors = watchErrors(page)
          await page.goto(path)
          await page.waitForLoadState('networkidle')
          await expect(page.locator('main h1').first()).toBeVisible()
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
          expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0)
          expect(errors).toEqual([])
        })
      }
    })

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
    test('a question’s Ask and Answer fit the screen', async ({ page }) => {
      const errors = watchErrors(page)
      await page.goto('/items')
      await page.getByRole('link').filter({ hasText: WORLD.items.longForm }).first().click()
      await expect(page.getByRole('heading', { name: WORLD.items.longForm })).toBeVisible()
      for (const button of ['Ask', 'Answer']) {
        await page.getByRole('button', { name: button, exact: true }).click()
        await expect(dialog(page)).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, `${button} scrolls sideways`).toBeLessThanOrEqual(0)
        await dialog(page).getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog(page)).toHaveCount(0)
      }
      expect(errors).toEqual([])
    })
    for (const hub of HUBS) {
      test(`${hub.name} fits the screen with its main column first`, async ({ page }) => {
        const errors = watchErrors(page)
        await page.goto(hub.list)
        await page.getByRole('link').filter({ hasText: hub.name }).first().click()
        await expect(page.getByRole('heading', { name: hub.name, exact: true })).toBeVisible()
        await page.waitForLoadState('networkidle')
        const top = async (title: string) =>
          (await page.getByRole('heading', { name: new RegExp(`^${title}`), level: 2 }).first().boundingBox())!.y
        expect(await top(hub.main)).toBeLessThan(await top(hub.side))
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0)
        expect(errors).toEqual([])
      })
    }
  })
}
