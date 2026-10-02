/* Verbatim lines: read by code, worded exactly, resolved the way quick-add resolves. */

import { describe, expect, it } from 'vitest'
import { parseVerbatim, resolveVerbatim } from '../lib/processing/verbatim'
import { db, resetBetweenTests } from './helpers/db'
import { makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('parseVerbatim', () => {
  it('takes the prefixed lines, in order, and nothing else', () => {
    const body = [
      'Budget talk went long.',
      'D: Move the retreat to May',
      '  q: who books the hall? @sarah',
      '- A: send the draft to the bishop',
      '* T: parking',
      '1. D: Keep the Sunday time',
      '- [ ] a: order chairs',
      'Decision: not a prefix',
      'Q:',
      'TD: neither is this',
    ].join('\n')

    expect(parseVerbatim(body)).toEqual([
      { kind: 'decision', text: 'Move the retreat to May' },
      { kind: 'question', text: 'who books the hall? @sarah' },
      { kind: 'action', text: 'send the draft to the bishop' },
      { kind: 'topic', text: 'parking' },
      { kind: 'decision', text: 'Keep the Sunday time' },
      { kind: 'action', text: 'order chairs' },
    ])
  })

  it('keeps the wording character for character', () => {
    const [line] = parseVerbatim('D:   We spend   $5,000 — no more.  ')
    expect(line).toEqual({ kind: 'decision', text: 'We spend   $5,000 — no more.' })
  })

  it('reads Windows line endings and an empty body', () => {
    expect(parseVerbatim('T: one\r\nT: two\r\n')).toHaveLength(2)
    expect(parseVerbatim('')).toEqual([])
  })
})

describe('resolveVerbatim', () => {
  it('leaves a line with no tokens exactly as written', async () => {
    const w = await makeWorld()
    const payload = await resolveVerbatim(db, w.parish.id, {
      kind: 'decision',
      text: 'We spend   $5,000 — no more.',
    })
    expect(payload).toEqual({
      type: 'item',
      kind: 'decision',
      text: 'We spend   $5,000 — no more.',
      parties: [],
      projectId: null,
    })
  })

  it('makes the people named on a question its owners and takes the project', async () => {
    const w = await makeWorld()
    const payload = await resolveVerbatim(db, w.parish.id, {
      kind: 'question',
      text: 'what is the lunch menu? @sarah @tom #retreat',
    })
    expect(payload.text).toBe('what is the lunch menu?')
    expect(payload.projectId).toBe(w.retreat.id)
    expect(payload.parties).toEqual([
      { role: 'owner', name: 'Sarah Jones', personId: w.sarah.id },
      { role: 'owner', name: 'Tom Baker', personId: w.tom.id },
    ])
  })

  it('reads @me as quick-add does: John owes it, the others are who it is owed to', async () => {
    const w = await makeWorld()
    const payload = await resolveVerbatim(db, w.parish.id, {
      kind: 'action',
      text: 'send the budget @me @sarah',
    })
    expect(payload.parties).toEqual([
      { role: 'owner', name: 'John', personId: w.john.id },
      { role: 'with', name: 'Sarah Jones', personId: w.sarah.id },
    ])
  })

  it('raises a topic with a group, and keeps a name inside the sentence', async () => {
    const w = await makeWorld()
    const payload = await resolveVerbatim(db, w.parish.id, {
      kind: 'topic',
      text: 'ask @bishop about the hall @staff',
    })
    expect(payload.text).toBe('ask Bishop Wright about the hall')
    expect(payload.parties).toEqual([
      { role: 'with', name: 'Bishop Wright', personId: w.bishop.id },
      { role: 'with', name: 'Staff', groupId: w.staff.id },
    ])
  })

  it('keeps a name that matches nobody as a party to be asked for, instead of failing', async () => {
    const w = await makeWorld()
    const payload = await resolveVerbatim(db, w.parish.id, {
      kind: 'action',
      text: 'book the caterer @priya #nosuchproject',
    })
    expect(payload.text).toBe('book the caterer')
    expect(payload.parties).toEqual([{ role: 'owner', name: 'priya' }])
    expect(payload.projectId).toBeNull()
  })

  it('does not reach a group or a project of another context', async () => {
    const w = await makeWorld()
    const payload = await resolveVerbatim(db, w.parish.id, {
      kind: 'topic',
      text: 'seating plan @council #synod',
    })
    expect(payload.parties).toEqual([{ role: 'with', name: 'council' }])
    expect(payload.projectId).toBeNull()
  })
})
