import { describe, expect, it } from 'vitest'
import { REOPEN_WINDOW_MS, mergeLink, type ItemSide, type TaskSide } from '../lib/connect/todoist/merge'
import { likeness } from '../lib/connect/todoist/match'

const now = new Date('2026-10-18T12:00:00Z')
const base = { text: 'Send the form', dueOn: '2026-10-20', closed: false }
const item = (patch: Partial<ItemSide> = {}): ItemSide => ({
  kind: 'action',
  status: 'open',
  text: base.text,
  dueOn: base.dueOn,
  deleted: false,
  johnOwns: true,
  eligible: true,
  ...patch,
})
const task = (patch: Partial<TaskSide> = {}): TaskSide => ({
  text: base.text,
  dueOn: base.dueOn,
  checked: false,
  deleted: false,
  recurring: false,
  ...patch,
})
const merge = (i: ItemSide | null, t: TaskSide | null, extra: { closedAt?: Date | null; base?: typeof base } = {}) =>
  mergeLink({ base: extra.base ?? base, item: i, task: t, closedAt: extra.closedAt ?? null, now })

describe('the three-way merge', () => {
  it('changes nothing when neither side moved', () => {
    const result = merge(item(), task())
    expect(result.itemOps).toEqual([])
    expect(result.commands).toEqual([])
    expect(result.unlink).toBeNull()
  })

  it('copies the item side to Todoist', () => {
    const result = merge(item({ text: 'Send the new form', dueOn: '2026-10-22' }), task())
    expect(result.commands).toEqual([
      { type: 'item_update', args: { content: 'Send the new form', deadline: { date: '2026-10-22' } } },
    ])
    expect(result.base).toMatchObject({ text: 'Send the new form', dueOn: '2026-10-22' })
  })

  it('clears the deadline in Todoist when the item loses its date', () => {
    expect(merge(item({ dueOn: null }), task()).commands).toEqual([
      { type: 'item_update', args: { deadline: null } },
    ])
  })

  it('copies the Todoist side to the item', () => {
    const result = merge(item(), task({ text: 'Send it', dueOn: null }))
    expect(result.itemOps).toEqual([{ op: 'edit', text: 'Send it', dueOn: null }])
    expect(result.commands).toEqual([])
  })

  it('lets Todoist win a field both changed, and keeps the other side of a field only one changed', () => {
    const result = merge(item({ text: 'Mine', dueOn: '2026-11-01' }), task({ text: 'Theirs' }))
    expect(result.itemOps).toEqual([{ op: 'edit', text: 'Theirs' }])
    expect(result.commands).toEqual([{ type: 'item_update', args: { deadline: { date: '2026-11-01' } } }])
    expect(result.base).toMatchObject({ text: 'Theirs', dueOn: '2026-11-01' })
  })

  it('closes an action ticked off in Todoist, and moves a question to needs answer', () => {
    expect(merge(item(), task({ checked: true })).itemOps).toEqual([{ op: 'complete' }])
    expect(merge(item({ kind: 'question' }), task({ checked: true })).itemOps).toEqual([{ op: 'needsAnswer' }])
    expect(merge(item(), task({ checked: true })).closedAt).toEqual(now)
  })

  it('closes the task when the item stops syncing', () => {
    const result = merge(item({ status: 'done', eligible: false }), task())
    expect(result.commands).toEqual([{ type: 'item_close' }])
    expect(result.base.closed).toBe(true)
  })

  it('reopens the task when the item is reopened', () => {
    const closed = { ...base, closed: true }
    const result = merge(item(), task({ checked: true }), { base: closed, closedAt: now })
    expect(result.commands).toEqual([{ type: 'item_uncomplete' }])
    expect(result.closedAt).toBeNull()
  })

  it('reopens the item when the task is reopened within 30 days', () => {
    const closed = { ...base, closed: true }
    const result = merge(item({ status: 'done', eligible: false }), task(), {
      base: closed,
      closedAt: new Date(now.getTime() - 5 * 24 * 3600 * 1000),
    })
    expect(result.itemOps).toEqual([{ op: 'reopen' }])
    expect(result.base.closed).toBe(false)
  })

  it('retires the link once 30 days closed', () => {
    const closed = { ...base, closed: true }
    const result = merge(item({ status: 'done', eligible: false }), task(), {
      base: closed,
      closedAt: new Date(now.getTime() - REOPEN_WINDOW_MS - 1000),
    })
    expect(result.unlink).toBe('expired')
    expect(result.itemOps).toEqual([])
  })

  it('closes the task again when what closed the item was not Todoist to undo', () => {
    const closed = { ...base, closed: true }
    const result = merge(item({ kind: 'topic', eligible: false }), task(), { base: closed, closedAt: now })
    expect(result.itemOps).toEqual([])
    expect(result.commands).toEqual([{ type: 'item_close' }])
  })

  it('unlinks a deleted or recurring task quietly', () => {
    expect(merge(item(), task({ deleted: true }))).toMatchObject({ unlink: 'deleted', itemOps: [], commands: [] })
    expect(merge(item(), task({ recurring: true }))).toMatchObject({ unlink: 'recurring', itemOps: [], commands: [] })
  })

  it('deletes the open task of an item that was removed, and leaves a closed one', () => {
    expect(merge(null, task())).toMatchObject({ unlink: 'item_removed', commands: [{ type: 'item_delete' }] })
    expect(merge(null, task({ checked: true }))).toMatchObject({ unlink: 'item_removed', commands: [] })
  })

  it('waits when Todoist has not reported the task yet', () => {
    expect(merge(item({ text: 'Changed' }), null)).toMatchObject({ itemOps: [], commands: [], unlink: null })
  })
})

describe('likeness', () => {
  it('ranks shared words', () => {
    const item = 'Send chairs the form for agency meeting dates'
    expect(likeness(item, 'Send agency chairs the meeting dates form')).toBeGreaterThan(
      likeness(item, 'Buy milk'),
    )
    expect(likeness(item, 'Buy milk')).toBe(0)
  })
})
