/*
 * Log a meeting: people and pasted notes become a meeting, its note and a
 * queued run in one commit, and the same processing then runs over it.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AppError, ValidationError } from '../lib/core/types'
import { meetings, notes, processingRuns } from '../lib/db/schema'
import { listItems } from '../lib/items/items'
import { logMeeting } from '../lib/meetings/log'
import { getMeeting } from '../lib/meetings/meetings'
import { listNotes } from '../lib/notes/notes'
import { approveAll, listProposals } from '../lib/processing/proposals'
import { latestRun, processQueued } from '../lib/processing/run'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

async function nothingWritten() {
  expect(await db.select().from(meetings)).toEqual([])
  expect(await db.select().from(notes)).toEqual([])
  expect(await db.select().from(processingRuns)).toEqual([])
}

describe('logMeeting', () => {
  it('makes the meeting, its people, a note and a queued run; processing and review do the rest', async () => {
    const w = await makeWorld()
    const startsAt = new Date('2026-09-30T14:00:00Z')
    const body = 'Caught Sarah in the corridor.\nD: Move the retreat to May #retreat\nA: book the hall @sarah'

    const logged = await logMeeting(db, actor, {
      contextId: w.parish.id,
      startsAt,
      minutes: 30,
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
      notes: `\n${body}\n`,
    })

    expect(logged.meeting).toMatchObject({
      contextId: w.parish.id,
      title: 'Sarah Jones',
      startsAt,
      endsAt: new Date('2026-09-30T14:30:00Z'),
      group: null,
      series: null,
      calendarEventId: null,
      people: [{ id: w.sarah.id, name: 'Sarah Jones' }],
      projects: [{ id: w.retreat.id, name: 'Retreat' }],
    })
    expect(await getMeeting(db, logged.meeting.id)).toEqual(logged.meeting)

    const saved = await listNotes(db, logged.meeting.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ id: logged.noteId, source: 'pasted', body, externalId: null })

    expect(await latestRun(db, logged.meeting.id)).toMatchObject({
      id: logged.runId,
      noteId: logged.noteId,
      status: 'queued',
      contentHash: saved[0]!.contentHash,
    })

    // Nothing is processed by logging it.
    expect(await listProposals(db, logged.meeting.id)).toEqual([])
    expect(await listItems(db, { contextId: w.parish.id })).toEqual([])

    expect(await processQueued(db, null)).toEqual({ processed: 1, failed: 0 })
    expect((await listProposals(db, logged.meeting.id)).map((p) => p.status)).toEqual(['pending', 'pending'])
    expect(await listItems(db, { contextId: w.parish.id })).toEqual([])

    expect(await approveAll(db, actor, logged.meeting.id)).toMatchObject({ accepted: 2, left: 0 })
    const made = await listItems(db, { contextId: w.parish.id, originMeetingId: logged.meeting.id })
    expect(
      made
        .map((item) => [item.kind, item.text, item.project?.name ?? null, item.parties.map((p) => p.name)])
        .sort(),
    ).toEqual([
      ['action', 'book the hall', null, ['Sarah Jones']],
      ['decision', 'Move the retreat to May', 'Retreat', []],
    ])
  })

  it('titles it from the people or the group unless one is given, and dates it now', async () => {
    const w = await makeWorld()
    const now = new Date('2026-10-01T18:00:00Z')
    const base = { contextId: w.parish.id, notes: 'chat' }

    const pair = await logMeeting(db, actor, { ...base, personIds: [w.tom.id, w.sarah.id] }, now)
    expect(pair.meeting).toMatchObject({ title: 'Sarah Jones & Tom Baker', startsAt: now, endsAt: now })

    const named = await logMeeting(db, actor, { ...base, title: '  Corridor chat ', personIds: [w.tom.id] }, now)
    expect(named.meeting.title).toBe('Corridor chat')

    const blank = await logMeeting(db, actor, { ...base, title: '   ', personIds: [w.tom.id] }, now)
    expect(blank.meeting.title).toBe('Tom Baker')

    // A group and nobody picked: its members were there.
    const staff = await logMeeting(db, actor, { ...base, personIds: [], groupId: w.staff.id }, now)
    expect(staff.meeting).toMatchObject({ title: 'Staff', group: { id: w.staff.id, name: 'Staff' } })
    expect(staff.meeting.people.map((p) => p.id).sort()).toEqual([w.sarah.id, w.tom.id].sort())

    // A group and one person picked: only that person.
    const one = await logMeeting(db, actor, { ...base, personIds: [w.sarah.id], groupId: w.staff.id }, now)
    expect(one.meeting.people.map((p) => p.id)).toEqual([w.sarah.id])
    expect(one.meeting.group?.id).toBe(w.staff.id)
  })

  it('never lists John among the people, and takes a person named twice once', async () => {
    const w = await makeWorld()
    const logged = await logMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.john.id, w.sarah.id, w.sarah.id],
      notes: 'chat',
    })
    expect(logged.meeting.people.map((p) => p.id)).toEqual([w.sarah.id])
    expect(logged.meeting.title).toBe('Sarah Jones')
  })

  it('refuses a project or a group from another context, and a person who does not exist', async () => {
    const w = await makeWorld()
    const base = { contextId: w.parish.id, personIds: [w.sarah.id], notes: 'D: something' }

    await expect(logMeeting(db, actor, { ...base, projectIds: [w.retreat.id, w.synod.id] })).rejects.toThrow(
      AppError,
    )
    await expect(logMeeting(db, actor, { ...base, groupId: w.council.id })).rejects.toThrow(AppError)
    await expect(logMeeting(db, actor, { ...base, personIds: [w.sarah.id, randomUUID()] })).rejects.toThrow(
      ValidationError,
    )
    await expect(logMeeting(db, actor, { ...base, personIds: ['not-an-id'] })).rejects.toThrow(
      ValidationError,
    )
    await expect(logMeeting(db, actor, { ...base, contextId: randomUUID() })).rejects.toThrow(AppError)
    await nothingWritten()
  })

  it('refuses empty notes and a duration or a time that is not one', async () => {
    const w = await makeWorld()
    const base = { contextId: w.parish.id, personIds: [w.sarah.id] }

    await expect(logMeeting(db, actor, { ...base, notes: '  \n ' })).rejects.toThrow(ValidationError)
    await expect(logMeeting(db, actor, { ...base, notes: 'chat', minutes: -5 })).rejects.toThrow(
      ValidationError,
    )
    await expect(logMeeting(db, actor, { ...base, notes: 'chat', minutes: Number.NaN })).rejects.toThrow(
      ValidationError,
    )
    await expect(
      logMeeting(db, actor, { ...base, notes: 'chat', startsAt: new Date('nonsense') }),
    ).rejects.toThrow(ValidationError)
    await nothingWritten()
  })
})
