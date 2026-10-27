import { describe, expect, it } from 'vitest'
import { getRecap } from '../lib/agenda/recap'
import { addMember } from '../lib/directory/groups'
import { addPersonEmail, createPerson } from '../lib/directory/people'
import { addAttendees, copyListIfOver, rollCall, takeRoll } from '../lib/meetings/attendance'
import { createMeeting, getMeeting, listMeetings, setMeetingPeople, updateMeeting } from '../lib/meetings/meetings'
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
const marks = async (meetingId: string) => (await rollCall(db, meetingId)).map((e) => [e.name, e.mark])

describe('the roll call', () => {
  it('lists everyone on it, not yet said, and keeps what John marks', async () => {
    const w = await makeWorld()
    const guest = await createPerson(db, { name: 'Guest Preacher' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      personIds: [w.bishop.id],
      startsAt: START,
      endsAt: new Date('2026-10-06T16:00:00Z'),
    })
    expect((await rollCall(db, meeting.id)).map((e) => [e.name, e.mark, e.via])).toEqual([
      ['Bishop Wright', null, 'person'],
      ['Sarah Jones', null, 'group'],
      ['Tom Baker', null, 'group'],
    ])

    // Sarah was here, Tom out, a guest turned up; the bishop is not yet said.
    const taken = await takeRoll(db, meeting.id, { here: [w.sarah.id, guest.id, w.john.id], out: [w.tom.id] }, DURING)
    expect(taken.attendanceAt).toEqual(DURING)
    expect(ids(taken.attendees)).toEqual(ids([w.bishop, w.sarah, guest]))
    expect(await marks(meeting.id)).toEqual([
      ['Bishop Wright', null],
      ['Guest Preacher', 'here'],
      ['Sarah Jones', 'here'],
      ['Tom Baker', 'out'],
    ])
    // He is not listed among the meetings he was at.
    expect(await listMeetings(db, { contextId: w.parish.id, personId: w.tom.id })).toEqual([])
    expect((await listMeetings(db, { contextId: w.parish.id, personId: w.sarah.id })).map((m) => m.id)).toEqual([meeting.id])
  })

  it('can be taken back to not yet said', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    await takeRoll(db, meeting.id, { here: [w.sarah.id], out: [w.tom.id] }, DURING)
    await takeRoll(db, meeting.id, { here: [], out: [], unsure: [w.sarah.id, w.tom.id] }, AFTER)
    expect(await marks(meeting.id)).toEqual([
      ['Sarah Jones', null],
      ['Tom Baker', null],
    ])
    // Tom keeps the group that brought him.
    expect((await rollCall(db, meeting.id)).find((e) => e.id === w.tom.id)?.groupId).toBe(w.staff.id)
  })

  it('someone added after it ended is here, and stays here when it is taken again', async () => {
    const w = await makeWorld()
    const guest = await createPerson(db, { name: 'Guest Preacher' })
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    expect(await copyListIfOver(db, meeting.id, AFTER)).toBe(true)

    await takeRoll(db, meeting.id, { here: [guest.id], out: [] }, AFTER)
    expect(await marks(meeting.id)).toEqual([
      ['Guest Preacher', 'here'],
      ['Sarah Jones', null],
      ['Tom Baker', null],
    ])
    // Taken again as it now reads, the guest is still here.
    await takeRoll(db, meeting.id, { here: [guest.id], out: [], unsure: [w.sarah.id, w.tom.id] }, AFTER)
    expect(await marks(meeting.id)).toEqual([
      ['Guest Preacher', 'here'],
      ['Sarah Jones', null],
      ['Tom Baker', null],
    ])
  })

  it('a member marked out before the list is copied stays out, and a new member is on it', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    const { meetingAbsences } = await import('../lib/db/schema')
    await db.insert(meetingAbsences).values({ meetingId: meeting.id, personId: w.tom.id })
    const curate = await createPerson(db, { name: 'New Curate' })
    await addMember(db, w.staff.id, curate.id)
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([w.sarah, curate]))
  })

  it('people added as having turned up are here', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    await takeRoll(db, meeting.id, { here: [], out: [w.tom.id] }, AFTER)
    await addAttendees(db, meeting.id, [w.tom.id, w.bishop.id, w.john.id])
    expect(await marks(meeting.id)).toEqual([
      ['Bishop Wright', 'here'],
      ['Sarah Jones', null],
      ['Tom Baker', 'here'],
    ])
  })
})

describe('who came with a group', () => {
  it('is told apart from who is on it by name, live and once copied', async () => {
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

    // Tom is out; a guest came, on their own.
    await takeRoll(db, meeting.id, { here: [w.bishop.id, w.sarah.id, guest.id], out: [w.tom.id] }, DURING)
    const taken = await getMeeting(db, meeting.id)
    expect(by(taken.attendees)).toEqual([
      ['Bishop Wright', null],
      ['Guest Preacher', null],
      ['Sarah Jones', w.staff.id],
    ])
    // Tom, marked out, is still shown under his group.
    expect(by(taken.absent)).toEqual([['Tom Baker', w.staff.id]])

    // An edit to its people keeps who came with the group, and who was here.
    await setMeetingPeople(db, actor, meeting.id, [w.sarah.id, guest.id])
    expect((await getMeeting(db, meeting.id)).attendees.map((one) => [one.name, one.groupId, one.here])).toEqual([
      ['Guest Preacher', null, true],
      ['Sarah Jones', w.staff.id, true],
    ])
  })

  it('added once the list is copied, brings its members, not yet said', async () => {
    const w = await makeWorld()
    const ray = await createPerson(db, { name: 'Ray Hall' })
    await addMember(db, w.staff.id, w.john.id)
    await addMember(db, w.staff.id, ray.id)
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.tom.id], startsAt: START })
    // Tom is here by name; Ray was marked out.
    await takeRoll(db, meeting.id, { here: [w.tom.id], out: [ray.id] }, AFTER)

    await updateMeeting(db, actor, meeting.id, { groupIds: [w.staff.id] })
    expect((await getMeeting(db, meeting.id)).attendees.map((one) => [one.name, one.groupId, one.here])).toEqual([
      ['Sarah Jones', w.staff.id, false],
      ['Tom Baker', null, true],
    ])

    // Taken off again, it takes whoever it brought and no one has said was there.
    await updateMeeting(db, actor, meeting.id, { groupIds: [] })
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual([w.tom.id])
  })
})

describe('the first look after', () => {
  it('copies the list of a meeting that is over, once, and confirms no one', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id, startsAt: START })
    expect(await copyListIfOver(db, meeting.id, DURING)).toBe(false)
    expect(await copyListIfOver(db, meeting.id, AFTER)).toBe(true)
    expect(await copyListIfOver(db, meeting.id, AFTER)).toBe(false)
    const copied = await getMeeting(db, meeting.id)
    expect(ids(copied.people)).toEqual(ids([w.sarah, w.tom]))
    expect(copied.attendees.every((one) => !one.here)).toBe(true)

    // Joining the group afterwards does not put anyone on it.
    const late = await createPerson(db, { name: 'Too Late' })
    await addMember(db, w.staff.id, late.id)
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([w.sarah, w.tom]))
  })

  it('processing its notes copies the list first, and accepting leaves it open to correct', async () => {
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

    const [proposal] = await listProposals(db, meeting.id)
    await acceptProposal(db, actor, proposal!.id)
    await takeRoll(db, meeting.id, { here: [w.sarah.id], out: [w.tom.id] })
    expect(await marks(meeting.id)).toEqual([
      ['Sarah Jones', 'here'],
      ['Tom Baker', 'out'],
    ])
    await takeRoll(db, meeting.id, { here: [w.sarah.id, w.tom.id], out: [] })
    expect(await marks(meeting.id)).toEqual([
      ['Sarah Jones', 'here'],
      ['Tom Baker', 'here'],
    ])
  })
})

describe('the recap', () => {
  it('goes to everyone invited, or to those who were there', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      personIds: [w.bishop.id],
      startsAt: START,
    })
    for (const [person, email] of [
      [w.sarah, 'sarah.recap@example.test'],
      [w.tom, 'tom.recap@example.test'],
      [w.bishop, 'bishop.recap@example.test'],
    ] as const) {
      await addPersonEmail(db, person.id, email)
    }
    await takeRoll(db, meeting.id, { here: [w.sarah.id], out: [w.tom.id] }, AFTER)
    const recap = await getRecap(db, meeting.id, { today: '2026-10-06', timeZone: null, now: AFTER, selfId: w.john.id })
    expect(recap.recipients.map((one) => one.name)).toEqual(['Bishop Wright', 'Sarah Jones', 'Tom Baker'])
    expect(recap.hereRecipients.map((one) => one.name)).toEqual(['Sarah Jones'])
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
