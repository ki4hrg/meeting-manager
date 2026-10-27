import { expect, test } from '@playwright/test'
import { dialog, openQuickAdd, selectContext, watchErrors } from './helpers'
import { WORLD } from './world'

const section = (page: import('@playwright/test').Page, title: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: false }) })

test("a topic takes questions under it, a detail and notes", async ({ page }) => {
  const errors = watchErrors(page)
  await selectContext(page, WORLD.contexts.conference)
  const stamp = Date.now()
  const loose = `When is the next step due? ${stamp}`
  const fresh = `Why is the review blocked? ${stamp}`

  // A question made elsewhere, to put under the topic.
  await openQuickAdd(page)
  await dialog(page).getByLabel('New item').fill(`Q: ${loose}`)
  await dialog(page).getByLabel('New item').press('Enter')
  await expect(dialog(page).getByLabel('New item')).toHaveValue('')
  await page.keyboard.press('Escape')

  await page.goto('/items')
  await page.getByRole('link').filter({ hasText: WORLD.items.accountability }).first().click()
  await expect(page.getByRole('heading', { name: WORLD.items.accountability })).toBeVisible()
  const questions = section(page, 'Questions')

  // A new question under it.
  await questions.getByRole('button', { name: 'New', exact: true }).click()
  await dialog(page).getByLabel('New item').fill(fresh)
  await dialog(page).getByLabel('New item').press('Enter')
  await expect(questions.getByRole('link').filter({ hasText: fresh })).toBeVisible()
  await page.keyboard.press('Escape')

  // An existing one linked under it.
  await questions.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog(page).getByLabel('Question').fill(loose)
  await dialog(page).getByRole('option').filter({ hasText: loose }).click()
  await dialog(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(questions.getByRole('link').filter({ hasText: loose })).toBeVisible()

  // A detail where there was none, and a note.
  await page.getByRole('button', { name: 'Detail', exact: true }).click()
  await dialog(page).getByLabel('Detail').fill(`Where each team stands ${stamp}`)
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('paragraph').filter({ hasText: `Where each team stands ${stamp}` })).toBeVisible()
  await section(page, 'Notes').getByRole('button', { name: 'Add', exact: true }).click()
  await dialog(page).getByLabel('Note').fill(`Adlene has a draft ${stamp}`)
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(section(page, 'Notes').getByText(`Adlene has a draft ${stamp}`)).toBeVisible()

  // The question names its topic, and comes out from under it.
  await questions.getByRole('link').filter({ hasText: loose }).click()
  await expect(page.getByRole('heading', { name: loose })).toBeVisible()
  await page.getByRole('button', { name: 'Remove from topic' }).click()
  await expect(page.getByRole('button', { name: 'Remove from topic' })).toHaveCount(0)
  expect(errors).toEqual([])
})
