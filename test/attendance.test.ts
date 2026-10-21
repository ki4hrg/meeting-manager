import { describe, expect, it } from 'vitest'
import { addMember } from '../lib/directory/groups'
import { createPerson } from '../lib/directory/people'
import { addAttendees, attendanceLocked, rollCall, settleAttendance, settleIfOver } from '../lib/meetings/attendance'
import { createMeeting, getMeeting, listMeetings, setMeetingPeople } from '../lib/meetings/meetings'
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

  it('someone added after it ended is here, and stays here when it is taken again', async () => {
    const w = await makeWorld()
    const guest = await createPerson(db, { name: 'Guest Preacher' })
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    expect(await settleIfOver(db, meeting.id, AFTER)).toBe(true)

    // Also here: the guest, with everyone who was marked here.
    const here = (await rollCall(db, meeting.id)).filter((e) => e.present).map((e) => e.id)
    await settleAttendance(db, meeting.id, [...here, guest.id], AFTER)
    const after = await rollCall(db, meeting.id)
    expect(after.map((e) => [e.name, e.present])).toEqual([
      ['Guest Preacher', true],
      ['Sarah Jones', true],
      ['Tom Baker', true],
    ])

    // Confirmed again as the roll call now reads, the guest is still here.
    await settleAttendance(db, meeting.id, after.filter((e) => e.present).map((e) => e.id), AFTER)
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([guest, w.sarah, w.tom]))
    expect((await rollCall(db, meeting.id)).every((e) => e.present)).toBe(true)
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

describe('who came with a group', () => {
  it('is told apart from who is on it by name, live and once settled', async () => {
    const w = await makeWorld()
    const guest = await createPerson(db, { name: 'Guest Preacher' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      personIds: [w.bishop.id],
      startsAt: START,
    })
    const by = (list: { name: string; groupId: string | null }[]) => list.map((one) => [one.name, one.groupId])
    expect(by((await getMeeting(db, meeting.id)).attendees)).toEqual([
      ['Bishop Wright', null],
      ['Sarah Jones', w.staff.id],
      ['Tom Baker', w.staff.id],
    ])
    expect((await rollCall(db, meeting.id)).map((e) => [e.name, e.groupId])).toEqual([
      ['Bishop Wright', null],
      ['Sarah Jones', w.staff.id],
      ['Tom Baker', w.staff.id],
    ])

    // Tom is out; a guest came, on their own.
    await settleAttendance(db, meeting.id, [w.bishop.id, w.sarah.id, guest.id], DURING)
    expect(by((await getMeeting(db, meeting.id)).attendees)).toEqual([
      ['Bishop Wright', null],
      ['Guest Preacher', null],
      ['Sarah Jones', w.staff.id],
    ])
    // Tom, marked out, is still shown under his group.
    expect((await rollCall(db, meeting.id)).find((e) => e.id === w.tom.id)).toMatchObject({
      present: false,
      groupId: w.staff.id,
    })

    // An edit to its people keeps who came with the group.
    await setMeetingPeople(db, actor, meeting.id, [w.sarah.id, guest.id])
    expect(by((await getMeeting(db, meeting.id)).attendees)).toEqual([
      ['Guest Preacher', null],
      ['Sarah Jones', w.staff.id],
    ])
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

  it('settles as it stands when a proposal was accepted before it ended', async () => {
    const w = await makeWorld()
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt })
    const { note } = await saveNote(db, actor, { meetingId: meeting.id, source: 'pasted', body: 'D: Keep the Thursday slot' })
    const run = await queueRun(db, note.id)
    await processRun(db, run!.id)
    expect((await getMeeting(db, meeting.id)).attendanceAt).toBeNull()
    const [proposal] = await listProposals(db, meeting.id)
    await acceptProposal(db, actor, proposal!.id)

    const after = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000)
    expect(await settleIfOver(db, meeting.id, after)).toBe(true)
    const settled = await getMeeting(db, meeting.id)
    expect(settled.attendanceAt).toEqual(after)
    expect(ids(settled.people)).toEqual(ids([w.sarah, w.tom]))
    await expect(settleAttendance(db, meeting.id, [w.sarah.id])).rejects.toThrow('stays as it is')
  })

  it('after an accept, someone who was there can still be added, but no one marked out', async () => {
    const w = await makeWorld()
    const guest = await createPerson(db, { name: 'Guest Preacher' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      startsAt: new Date('2020-01-01T15:00:00Z'),
    })
    const { note } = await saveNote(db, actor, { meetingId: meeting.id, source: 'pasted', body: 'D: Keep the Thursday slot' })
    const run = await queueRun(db, note.id)
    await processRun(db, run!.id)
    // Tom was out.
    await settleAttendance(db, meeting.id, [w.sarah.id])
    const [proposal] = await listProposals(db, meeting.id)
    await acceptProposal(db, actor, proposal!.id)
    expect(await attendanceLocked(db, meeting.id)).toBe(true)

    // Tom was there after all, and so was a guest.
    await addAttendees(db, meeting.id, [w.tom.id, guest.id, w.john.id])
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([guest, w.sarah, w.tom]))
    expect((await rollCall(db, meeting.id)).every((e) => e.present)).toBe(true)
    expect((await listMeetings(db, { contextId: w.parish.id, personId: w.tom.id })).map((m) => m.id)).toEqual([meeting.id])

    // Taking anyone off stays refused.
    await expect(settleAttendance(db, meeting.id, [w.sarah.id])).rejects.toThrow('stays as it is')
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([guest, w.sarah, w.tom]))
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
