/* Notes: saved once per version, several to a meeting, movable only within one event. */

import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ValidationError } from '../lib/core/types'
import { proposals } from '../lib/db/schema'
import { createMeeting, getMeeting } from '../lib/meetings/meetings'
import { sessionFromNote } from '../lib/meetings/prep'
import { getNote, hashNote, listNotes, moveNote, saveNote } from '../lib/notes/notes'
import { acceptProposal, addProposals, listProposals, rejectProposal } from '../lib/processing/proposals'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const item = (text: string) => ({
  payload: { type: 'item' as const, kind: 'topic' as const, text, parties: [] },
})

describe('hashNote', () => {
  it('covers body, summary and transcript, and tells them apart', () => {
    const base = hashNote({ body: 'a', summary: 'b', transcript: 'c' })
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(hashNote({ body: 'a', summary: 'b', transcript: 'c' })).toBe(base)
    expect(hashNote({ body: 'a', summary: 'b', transcript: 'd' })).not.toBe(base)
    expect(hashNote({ body: 'a', summary: 'x', transcript: 'c' })).not.toBe(base)
    expect(hashNote({ body: 'ab', summary: null })).not.toBe(hashNote({ body: 'a', summary: 'b' }))
    expect(hashNote({ body: 'a' })).toBe(hashNote({ body: 'a', summary: null, transcript: null }))
  })
})

describe('saveNote', () => {
  it('upserts a Granola note on its external id and says whether the content changed', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Staff' })
    const input = {
      meetingId: meeting.id,
      source: 'granola' as const,
      externalId: 'g-1',
      title: 'Staff meeting',
      body: 'D: one',
      summary: 'We met.',
      transcript: 'hello',
    }

    const first = await saveNote(db, actor, input)
    expect(first.changed).toBe(true)
    expect(first.note.contentHash).toBe(hashNote(input))

    const again = await saveNote(db, actor, input)
    expect(again.changed).toBe(false)
    expect(again.note.id).toBe(first.note.id)

    const edited = await saveNote(db, actor, { ...input, summary: 'We met and decided.' })
    expect(edited.changed).toBe(true)
    expect(edited.note.id).toBe(first.note.id)
    expect(edited.note.summary).toBe('We met and decided.')
    expect(edited.note.contentHash).not.toBe(first.note.contentHash)

    expect(await listNotes(db, meeting.id)).toHaveLength(1)
  })

  it('makes a new row for every pasted note, even the same text', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Staff' })
    const a = await saveNote(db, actor, { meetingId: meeting.id, source: 'pasted', body: 'same' })
    const b = await saveNote(db, actor, { meetingId: meeting.id, source: 'pasted', body: 'same' })
    expect(a.changed && b.changed).toBe(true)
    expect(b.note.id).not.toBe(a.note.id)
    expect((await listNotes(db, meeting.id)).map((note) => note.id)).toEqual([a.note.id, b.note.id])
  })

  it('refuses an empty pasted note and a meeting that does not exist', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Staff' })
    await expect(
      saveNote(db, actor, { meetingId: meeting.id, source: 'pasted', body: '   ' }),
    ).rejects.toThrow(ValidationError)
    await expect(
      saveNote(db, actor, {
        meetingId: '00000000-0000-4000-8000-000000000000',
        source: 'pasted',
        body: 'x',
      }),
    ).rejects.toThrow(/not found/)
  })

  it('leaves a re-delivered note on the session it was moved to', async () => {
    const w = await makeWorld()
    const retreat = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat' })
    const day1 = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Day 1',
      parentMeetingId: retreat.id,
    })
    const input = { meetingId: retreat.id, source: 'granola' as const, externalId: 'g-2', body: 'one' }
    const { note } = await saveNote(db, actor, input)
    await moveNote(db, actor, note.id, day1.id)

    const edited = await saveNote(db, actor, { ...input, body: 'two' })
    expect(edited.note.meetingId).toBe(day1.id)
  })
})

describe('moveNote', () => {
  async function event() {
    const w = await makeWorld()
    const retreat = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat' })
    const day1 = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Day 1',
      parentMeetingId: retreat.id,
    })
    const day2 = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Day 2',
      parentMeetingId: retreat.id,
    })
    const other = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Unrelated' })
    const { note } = await saveNote(db, actor, {
      meetingId: retreat.id,
      source: 'pasted',
      body: 'notes',
    })
    return { w, retreat, day1, day2, other, note }
  }

  it('files a note on a session, on another session and back, and nowhere else', async () => {
    const { retreat, day1, day2, other, note } = await event()

    expect((await moveNote(db, actor, note.id, day1.id)).meetingId).toBe(day1.id)
    expect((await moveNote(db, actor, note.id, day2.id)).meetingId).toBe(day2.id)
    expect((await moveNote(db, actor, note.id, retreat.id)).meetingId).toBe(retreat.id)

    await expect(moveNote(db, actor, note.id, other.id)).rejects.toThrow(
      'A note can only move between a meeting and its own sessions.',
    )
    expect((await getNote(db, note.id)).meetingId).toBe(retreat.id)
  })

  it('takes pending and rejected proposals along and leaves accepted ones where the item was made', async () => {
    const { retreat, day1, note } = await event()
    const where = { meetingId: retreat.id, noteId: note.id }
    await addProposals(db, where, [item('stays pending'), item('gets accepted'), item('gets rejected')])
    // From another note of the parent: not this note's to take.
    await addProposals(db, { meetingId: retreat.id }, [item('someone else')])

    const before = await listProposals(db, retreat.id)
    const byText = (text: string) =>
      before.find((p) => p.payload.type === 'item' && p.payload.text === text)!
    const accepted = await acceptProposal(db, actor, byText('gets accepted').id)
    await rejectProposal(db, actor, byText('gets rejected').id)

    await moveNote(db, actor, note.id, day1.id)

    const texts = (list: Awaited<ReturnType<typeof listProposals>>) =>
      list.map((p) => (p.payload.type === 'item' ? `${p.payload.text}:${p.status}` : '')).sort()
    expect(texts(await listProposals(db, day1.id))).toEqual([
      'gets rejected:rejected',
      'stays pending:pending',
    ])
    expect(texts(await listProposals(db, retreat.id))).toEqual([
      'gets accepted:accepted',
      'someone else:pending',
    ])
    expect(accepted.made?.item?.originMeetingId).toBe(retreat.id)
  })

  it('drops a moved proposal the session already has instead of doubling it', async () => {
    const { retreat, day1, note } = await event()
    await addProposals(db, { meetingId: day1.id }, [item('Book the hall')])
    await addProposals(db, { meetingId: retreat.id, noteId: note.id }, [
      item('book the hall.'),
      item('Order chairs'),
    ])

    await moveNote(db, actor, note.id, day1.id)

    const there = await listProposals(db, day1.id)
    expect(there.map((p) => (p.payload.type === 'item' ? p.payload.text : ''))).toEqual([
      'Book the hall',
      'Order chairs',
    ])
    expect(await db.select().from(proposals).where(eq(proposals.meetingId, retreat.id))).toEqual([])
  })
})

describe('sessionFromNote', () => {
  it('makes a second sitting a session of its meeting, with its people, groups and projects', async () => {
    const w = await makeWorld()
    const visit = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Site visit',
      startsAt: new Date('2026-10-26T15:00:00Z'),
      endsAt: new Date('2026-10-26T16:00:00Z'),
      personIds: [w.sarah.id],
      groupIds: [w.staff.id],
      projectIds: [w.campaign.id],
    })
    const tour = await saveNote(db, actor, { meetingId: visit.id, source: 'pasted', body: 'the tour' })
    const { note } = await saveNote(db, actor, {
      meetingId: visit.id,
      source: 'granola',
      externalId: 'not_debrief000001',
      title: 'Site visit debrief',
      body: 'the debrief',
      filing: {
        startsAt: '2026-10-26T15:53:00Z',
        endsAt: '2026-10-26T16:50:00Z',
        calendarEventId: null,
      },
    })
    await addProposals(db, { meetingId: visit.id, noteId: note.id }, [item('Find a piano')])

    const session = await sessionFromNote(db, actor, note.id)

    expect(session).toMatchObject({
      parentMeetingId: visit.id,
      title: 'Site visit debrief',
      startsAt: new Date('2026-10-26T15:53:00Z'),
      endsAt: new Date('2026-10-26T16:50:00Z'),
    })
    expect(session.people.map((one) => one.id)).toEqual([w.sarah.id])
    expect(session.groups.map((one) => one.id)).toEqual([w.staff.id])
    expect(session.projects.map((one) => one.id)).toEqual([w.campaign.id])
    expect((await getNote(db, note.id)).meetingId).toBe(session.id)
    expect((await listProposals(db, session.id)).map((p) => p.payload.type === 'item' && p.payload.text)).toEqual([
      'Find a piano',
    ])
    // The first sitting stays on the meeting, which now has the session.
    expect((await listNotes(db, visit.id)).map((one) => one.id)).toEqual([tour.note.id])
    expect((await getMeeting(db, visit.id)).sessions.map((one) => one.id)).toEqual([session.id])
  })
})
