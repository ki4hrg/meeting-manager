/* What a series stores of its skeleton and blocks, whatever it was sent. */

import { describe, expect, it } from 'vitest'
import { ValidationError } from '../lib/core/types'
import type { BlockSettings, SkeletonSection } from '../lib/db/schema'
import {
  cleanSkeleton,
  createSeries,
  setSeriesProjects,
  skeletonFromOutline,
  updateSeries,
} from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('skeleton', () => {
  it('trims, drops blank lines and keeps minutes only when given', async () => {
    const { parish } = await makeWorld()
    const series = await createSeries(db, { contextId: parish.id, name: 'Staff' })

    const saved = await updateSeries(db, series.id, {
      skeleton: [
        {
          title: '  Opening ',
          lines: [{ text: ' Prayer ', minutes: 5 }, { text: '   ' }, { text: 'Check-in', minutes: null }],
        },
        { title: 'Business', lines: [] },
      ],
    })

    expect(saved.skeleton).toEqual([
      { title: 'Opening', lines: [{ text: 'Prayer', minutes: 5 }, { text: 'Check-in' }] },
      { title: 'Business', lines: [] },
    ])
  })

  it('refuses a section with no title rather than dropping its lines', async () => {
    const { parish } = await makeWorld()
    const series = await createSeries(db, { contextId: parish.id, name: 'Staff' })

    await expect(
      updateSeries(db, series.id, { skeleton: [{ title: ' ', lines: [{ text: 'Kept?' }] }] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses minutes that are not a whole number of them', () => {
    const withMinutes = (minutes: unknown) => [{ title: 'A', lines: [{ text: 'x', minutes }] }]

    for (const minutes of [0, -5, 2.5, 'soon', 100_000]) {
      expect(() => cleanSkeleton(withMinutes(minutes))).toThrow(ValidationError)
    }
    expect(cleanSkeleton(withMinutes('15'))[0]!.lines[0]).toEqual({ text: 'x', minutes: 15 })
  })

  it('refuses what is not a skeleton at all', () => {
    expect(() => cleanSkeleton('nope')).toThrow(ValidationError)
    expect(() => cleanSkeleton([null])).toThrow(ValidationError)
    expect(cleanSkeleton([{ title: 'A', lines: 'nope' }])).toEqual([{ title: 'A', lines: [] }])
  })

  it('cleans the skeleton a series is created with', async () => {
    const { parish } = await makeWorld()
    const series = await createSeries(db, {
      contextId: parish.id,
      name: 'Staff',
      skeleton: [{ title: ' A ', lines: [{ text: '' }] }] as SkeletonSection[],
    })
    expect(series.skeleton).toEqual([{ title: 'A', lines: [] }])
  })
})

describe('a pasted outline', () => {
  const expected = [
    { title: 'Welcome', lines: [{ text: 'Opening prayer', minutes: 5 }, { text: 'Apologies' }] },
    { title: 'Reports', lines: [{ text: 'Treasurer', minutes: 10 }] },
    { title: 'Any other business', lines: [] },
  ]

  it('takes bullets under a heading as the lines of that section', () => {
    expect(
      skeletonFromOutline(
        '# Welcome\n- Opening prayer 5\n- Apologies\n\n# Reports\n- Treasurer 10 min\n\n# Any other business\n',
      ),
    ).toEqual(expected)
  })

  it('takes deeper headings as lines', () => {
    expect(
      skeletonFromOutline(
        '# Welcome\n## Opening prayer 5\n## Apologies\n# Reports\n## Treasurer 10 min\n# Any other business',
      ),
    ).toEqual(expected)
  })

  it('takes nested bullets as lines when there are no headings', () => {
    expect(
      skeletonFromOutline(
        '- Welcome\n  - Opening prayer 5\n  - Apologies\n- Reports\n  - Treasurer 10 min\n- Any other business',
      ),
    ).toEqual(expected)
  })

  it('makes nothing of text that is not an outline', () => {
    expect(skeletonFromOutline('just a sentence')).toEqual([])
    expect(skeletonFromOutline('')).toEqual([])
  })

  it('does not take a year for a number of minutes', () => {
    expect(skeletonFromOutline('# Plans\n- Budget 2027')[0]!.lines[0]).not.toHaveProperty('minutes')
  })
})

describe('blocks', () => {
  it('stores three booleans whatever was sent', async () => {
    const { parish } = await makeWorld()
    const series = await createSeries(db, { contextId: parish.id, name: 'Staff' })

    const saved = await updateSeries(db, series.id, {
      blocks: { followUps: true, lookahead: 'yes', extra: 1 } as unknown as BlockSettings,
    })
    expect(saved.blocks).toEqual({ followUps: true, sinceLast: false, lookahead: false })
  })
})

describe('projects', () => {
  it('takes a project named twice as one', async () => {
    const { parish, retreat } = await makeWorld()

    const created = await createSeries(db, {
      contextId: parish.id,
      name: 'Staff',
      projectIds: [retreat.id, retreat.id],
    })
    expect(created.projects.map((project) => project.id)).toEqual([retreat.id])

    const set = await setSeriesProjects(db, created.id, [retreat.id, retreat.id])
    expect(set.projects).toHaveLength(1)
  })
})
