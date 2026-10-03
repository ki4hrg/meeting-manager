import { describe, expect, it } from 'vitest'
import { addMember } from '../lib/directory/groups'
import { createPerson } from '../lib/directory/people'
import { rollCall, settleAttendance, settleIfOver } from '../lib/meetings/attendance'
import { createMeeting, getMeeting, listMeetings } from '../lib/meetings/meetings'
import { saveNote } from '../lib/notes/notes'
import { acceptProposal, listProposals } from '../lib/processing/proposals'
import { processRun, queueRun } from '../lib/processing/run'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const START = new Date('2026-10-06T15:00:00Z')
const DURING = new Date('2026-10-06T15:20:00Z')
const AFTER = new Date('2026-10-06T17:00:00Z')

const ids = (list: { id: string }[]) => list.map((one) => one.id).sort()

describe('the roll call', () => {
  it('lists everyone expected, marks who is out, and settles who was there', async () => {
    const w = await makeWorld()
    const guest = await createPerson(db, { name: 'Guest Preacher' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      personIds: [w.bishop.id],
      startsAt: START,
      endsAt: new Date('2026-10-06T16:00:00Z'),
    })
    expect((await rollCall(db, meeting.id)).map((e) => [e.name, e.present, e.via])).toEqual([
      ['Bishop Wright', true, 'person'],
      ['Sarah Jones', true, 'group'],
      ['Tom Baker', true, 'group'],
    ])

    // Tom is out; a guest turned up.
    const settled = await settleAttendance(db, meeting.id, [w.bishop.id, w.sarah.id, guest.id, w.john.id], DURING)
    expect(settled.attendanceAt).toEqual(DURING)
    expect(ids(settled.attendees)).toEqual(ids([w.bishop, w.sarah, guest]))
    expect((await rollCall(db, meeting.id)).map((e) => [e.name, e.present])).toEqual([
      ['Bishop Wright', true],
      ['Guest Preacher', true],
      ['Sarah Jones', true],
      ['Tom Baker', false],
    ])
    // He is not listed among the meetings he was at.
    expect(await listMeetings(db, { contextId: w.parish.id, personId: w.tom.id })).toEqual([])
    expect((await listMeetings(db, { contextId: w.parish.id, personId: w.sarah.id })).map((m) => m.id)).toEqual([meeting.id])
  })

  it('a member marked out before it is settled stays out, and a new member is in', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    const { meetingAbsences } = await import('../lib/db/schema')
    await db.insert(meetingAbsences).values({ meetingId: meeting.id, personId: w.tom.id })
    const curate = await createPerson(db, { name: 'New Curate' })
    await addMember(db, w.staff.id, curate.id)
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([w.sarah, curate]))
  })
})

describe('settling on the first look after', () => {
  it('settles a meeting that is over, as it stands, once', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    expect(await settleIfOver(db, meeting.id, DURING)).toBe(false)
    expect(await settleIfOver(db, meeting.id, AFTER)).toBe(true)
    expect(await settleIfOver(db, meeting.id, AFTER)).toBe(false)
    const settled = await getMeeting(db, meeting.id)
    expect(ids(settled.people)).toEqual(ids([w.sarah, w.tom]))

    // Joining the group afterwards does not put anyone at it.
    const late = await createPerson(db, { name: 'Too Late' })
    await addMember(db, w.staff.id, late.id)
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([w.sarah, w.tom]))
  })

  it('processing its notes settles it first, and an accepted proposal fixes it', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      startsAt: new Date('2020-01-01T15:00:00Z'),
    })
    const { note } = await saveNote(db, actor, { meetingId: meeting.id, source: 'pasted', body: 'D: Keep the Thursday slot' })
    const run = await queueRun(db, note.id)
    await processRun(db, run!.id)
    expect((await getMeeting(db, meeting.id)).attendanceAt).toBeInstanceOf(Date)

    // Correctable until something from the notes is accepted.
    await settleAttendance(db, meeting.id, [w.sarah.id])
    const [proposal] = await listProposals(db, meeting.id)
    await acceptProposal(db, actor, proposal!.id)
    await expect(settleAttendance(db, meeting.id, [w.sarah.id, w.tom.id])).rejects.toThrow('stays as it is')
  })
})

describe('people added to a meeting', () => {
  it('join the series’ roster when asked, and reach its next meetings', async () => {
    const w = await makeWorld()
    const { createSeries, addToRoster } = await import('../lib/meetings/series')
    const { setMeetingPeople } = await import('../lib/meetings/meetings')
    const weekly = await createSeries(db, { contextId: w.parish.id, name: 'Weekly', personIds: [w.sarah.id] })
    const at = (iso: string) => createMeeting(db, actor, { contextId: w.parish.id, seriesId: weekly.id, startsAt: new Date(iso) })
    const first = await at('2030-01-06T15:00:00Z')
    const second = await at('2030-01-13T15:00:00Z')

    await setMeetingPeople(db, actor, first.id, [w.sarah.id, w.tom.id])
    const roster = await addToRoster(db, weekly.id, [w.sarah.id, w.tom.id], [w.staff.id])
    expect(ids(roster.people)).toEqual(ids([w.sarah, w.tom]))
    expect(roster.groups.map((g) => g.id)).toEqual([w.staff.id])
    expect(ids((await getMeeting(db, second.id)).people)).toEqual(ids([w.sarah, w.tom]))
  })

  it('stay when the calendar event says otherwise: invitees only ever add', async () => {
    const w = await makeWorld()
    const { prepFromEvent } = await import('../lib/meetings/prep')
    const { setMeetingPeople } = await import('../lib/meetings/meetings')
    const event = {
      calendarId: 'cal-1',
      eventId: 'evt-1',
      seriesId: null,
      title: 'Planning',
      startsAt: START,
      endsAt: new Date('2026-10-06T16:00:00Z'),
      allDay: false,
      attendees: [{ personId: w.sarah.id, email: 'sarah@example.test', name: null, declined: false }],
      location: null,
      htmlLink: null,
    }
    const meeting = await prepFromEvent(db, actor, { contextId: w.parish.id, event })
    // Sarah taken off by hand, Tom added by hand.
    await setMeetingPeople(db, actor, meeting.id, [w.tom.id])
    const again = await prepFromEvent(db, actor, { contextId: w.parish.id, event })
    expect(again.id).toBe(meeting.id)
    expect(ids(again.people)).toEqual([w.tom.id])
  })
})
