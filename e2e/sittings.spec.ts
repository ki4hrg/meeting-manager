import { expect, test } from '@playwright/test'
import { selectContext } from './helpers'
import { WORLD } from './world'

/* Two conversations back to back, one after a meeting: which is its own meeting and which a session is John's to say. */

test('a 1:1 filed on the meeting before it is split off into a meeting of its own', async ({ page }) => {
  await selectContext(page, WORLD.contexts.church)
  await page.goto('/meetings/past')
  await page.getByRole('link').filter({ hasText: WORLD.meetings.siteVisit }).first().click()
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}/)
  const visit = /\/meetings\/[0-9a-f-]{36}/.exec(page.url())![0]
  await page.goto(`${visit}/review`)

  const notes = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Notes/ }) })
  const oneToOne = notes.getByRole('listitem').filter({ hasText: WORLD.notes.oneToOne })
  await oneToOne.getByRole('button', { name: 'Own meeting' }).click()

  // Its own meeting's review opens.
  await page.waitForURL((url) => url.pathname.endsWith('/review') && !url.pathname.startsWith(visit))
  await expect(notes.getByRole('listitem').filter({ hasText: WORLD.notes.oneToOne })).toBeVisible()

  // The visit keeps the tour, and with one note left there is nothing to split.
  await page.goto(`${visit}/review`)
  await expect(notes.getByRole('listitem').filter({ hasText: WORLD.notes.tour })).toBeVisible()
  await expect(notes.getByText(WORLD.notes.oneToOne)).toHaveCount(0)
  await expect(notes.getByRole('button', { name: 'Own meeting' })).toHaveCount(0)
})

test('a debrief just after a meeting is made a session of it', async ({ page }) => {
  await selectContext(page, WORLD.contexts.church)
  await page.goto('/meetings/past')
  await page.getByRole('link').filter({ hasText: WORLD.meetings.debrief }).first().click()
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}/)
  const debrief = /\/meetings\/[0-9a-f-]{36}/.exec(page.url())![0]
  await page.goto(`${debrief}/review`)

  await page.getByRole('button', { name: `Session of ${WORLD.meetings.walkThrough}` }).click()
  await expect(page.getByRole('button', { name: `Session of ${WORLD.meetings.walkThrough}` })).toHaveCount(0)

  // It sits under the walk-through now, and the walk-through lists it.
  const up = page.getByRole('navigation').getByRole('link', { name: WORLD.meetings.walkThrough })
  await expect(up).toBeVisible()
  await up.click()
  const sessions = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Sessions/ }) })
  await expect(sessions.getByText(WORLD.meetings.debrief)).toBeVisible()

  // Joined by mistake: it comes out again, a meeting of its own.
  await page.goto(`${debrief}/review`)
  await page.getByRole('button', { name: 'Own meeting', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Own meeting', exact: true })).toHaveCount(0)
  await expect(page.getByRole('navigation').getByRole('link', { name: WORLD.meetings.walkThrough })).toHaveCount(0)
})
