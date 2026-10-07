/*
 * The Projects page's tree (projectTree): a pure function over rows.
 */

import { describe, expect, it } from 'vitest'
import { projectTree } from '../lib/projects/projects'

const row = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId })

describe('projectTree', () => {
  it('nests three levels under their roots, siblings by name', () => {
    const roots = projectTree([
      row('w', 'AC2027 Worship', 'y'),
      row('ac', 'Annual Conference'),
      row('y', '2027 Annual Conference', 'ac'),
      row('m', 'AC2027 Music', 'y'),
      row('b', 'Budget'),
    ])
    expect(roots.map((one) => one.id)).toEqual(['ac', 'b'])
    const [ac] = roots
    expect(ac!.children.map((one) => one.id)).toEqual(['y'])
    expect(ac!.children[0]!.children.map((one) => [one.id, one.depth])).toEqual([
      ['m', 2],
      ['w', 2],
    ])
    expect(roots.every((one) => !one.archived)).toBe(true)
  })

  it('keeps an archived parent, muted, above its live sub-project, and no other archived row', () => {
    const roots = projectTree(
      [row('roof', 'Roof repair', 'fund'), row('ac', 'Annual Conference')],
      [row('fund', 'Building fund'), row('old', 'Old campaign')],
    )
    expect(roots.map((one) => [one.id, one.archived])).toEqual([
      ['ac', false],
      ['fund', true],
    ])
    expect(roots[1]!.children.map((one) => [one.id, one.archived])).toEqual([['roof', false]])
  })
})
