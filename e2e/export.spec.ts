import { expect, test } from '@playwright/test'
import { WORLD } from './world'

test('exporting an agenda copies the parts chosen and remembers them', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/people')
  await page.getByRole('link').filter({ hasText: WORLD.people.adlene }).first().click()
  await page.getByRole('button', { name: 'Prep', exact: true }).click()
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/)

  await page.getByRole('button', { name: 'Export' }).click()
  const modal = page.getByRole('dialog', { name: 'Export' })
  await expect(modal.getByRole('button', { name: 'Private' })).toHaveAttribute('aria-pressed', 'true')
  await expect(modal.getByRole('img', { name: 'Private' }).first()).toBeVisible()

  await modal.getByRole('button', { name: 'Shareable' }).click()
  await expect(modal.getByRole('checkbox', { name: 'Private notes' })).not.toBeChecked()
  await modal.getByRole('checkbox', { name: 'Attendees' }).uncheck()
  await modal.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByText('Copied', { exact: true })).toBeVisible()

  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toMatch(/^# /)
  expect(text).toContain(WORLD.items.accountability)
  expect(text.split('\n')[1] ?? '').not.toContain(WORLD.people.adlene)

  // The choice is kept for the next export.
  await page.reload()
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByRole('checkbox', { name: 'Attendees' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Shareable' })).toHaveAttribute('aria-pressed', 'false')
})
