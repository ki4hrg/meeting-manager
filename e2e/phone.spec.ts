import { expect, test } from '@playwright/test'
import { watchErrors } from './helpers'
import { WORLD } from './world'

const PAGES = ['/', '/inbox', '/meetings', '/meetings/past', '/projects', '/people', '/groups', '/series', '/settings', '/design']

/* Hubs, reached from their list: a heading from the main column and one from the side. */
const HUBS = [
  { list: '/projects', name: WORLD.projects.year, main: 'Owed', side: 'Milestones' },
  { list: '/people', name: WORLD.people.adlene, main: 'Raise', side: 'Meetings' },
  { list: '/meetings', name: WORLD.meetings.checkIn, main: 'Agenda', side: 'Blocks' },
]

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
