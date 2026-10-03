import { describe, expect, it } from 'vitest'
import { byHorizon, isLater, splitLater } from '../lib/items/horizon'

const TODAY = '2026-10-03'
const item = (id: string, dueOn: string | null, park?: { laterOn: string | null }) => ({
  id,
  dueOn,
  parkedAt: park ? new Date('2026-10-01T12:00:00Z') : null,
  laterOn: park?.laterOn ?? null,
})

describe('I owe by horizon', () => {
  it('puts overdue and due soon first, then the undated, then what is due further out', () => {
    const list = [
      item('undated-new', null),
      item('far', '2027-01-15'),
      item('soon', '2026-10-10'),
      item('undated-old', null),
      item('overdue', '2026-09-30'),
      item('edge', '2026-10-17'),
      item('past-edge', '2026-10-18'),
    ]
    expect(byHorizon(list, TODAY).map((one) => one.id)).toEqual([
      'overdue',
      'soon',
      'edge',
      'undated-new',
      'undated-old',
      'past-edge',
      'far',
    ])
  })

  it('keeps a parked item off the list until its day', () => {
    expect(isLater(item('a', null, { laterOn: '2026-11-01' }), TODAY)).toBe(true)
    expect(isLater(item('a', null, { laterOn: TODAY }), TODAY)).toBe(false)
    expect(isLater(item('a', null, { laterOn: '2026-10-01' }), TODAY)).toBe(false)
  })

  it('keeps an undated park until brought back', () => {
    expect(isLater(item('a', null, { laterOn: null }), TODAY)).toBe(true)
    expect(isLater(item('a', '2027-06-01', { laterOn: null }), TODAY)).toBe(true)
  })

  it('brings a parked item back when its deadline comes close, so a deadline is never hidden', () => {
    expect(isLater(item('a', '2026-10-12', { laterOn: null }), TODAY)).toBe(false)
    expect(isLater(item('a', '2026-09-01', { laterOn: '2027-01-01' }), TODAY)).toBe(false)
  })

  it('splits a list into now and later, later soonest back first and undated last', () => {
    const { now, later } = splitLater(
      [
        item('open', null),
        item('back-never', null, { laterOn: null }),
        item('back-dec', null, { laterOn: '2026-12-01' }),
        item('back-nov', null, { laterOn: '2026-11-01' }),
        item('back-today', '2026-12-25', { laterOn: TODAY }),
      ],
      TODAY,
    )
    expect(now.map((one) => one.id)).toEqual(['open', 'back-today'])
    expect(later.map((one) => one.id)).toEqual(['back-nov', 'back-dec', 'back-never'])
  })
})
