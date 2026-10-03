/*
 * The recap (docs/SPEC.md, "Workflow" → Export). Its leak cases sit with the
 * other candidate rules in candidate-rules.test.ts; this file holds what a
 * recap is made of and how it is written out.
 *
 * Meetings here are dated in the past of any clock the suite runs on, because
 * "closed at or after the meeting" is read against real timestamps.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { placeItem } from '../lib/agenda/candidates'
import { addLine, addSection, removeLine } from '../lib/agenda/lines'
import {
  getRecap,
  recapMailto,
  renderPersonSnippet,
  renderRecap,
  renderRecapHtml,
  type Recap,
} from '../lib/agenda/recap'
import { notes, personEmails, processingRuns, type RunOutput } from '../lib/db/schema'
import { createPerson } from '../lib/directory/people'
import {
  answerItem,
  completeItem,
  createItem,
  dropItem,
  recordDecision,
  supersedeDecision,
} from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { addMilestone } from '../lib/projects/projects'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const ZONE = 'America/Chicago'
const START = new Date('2025-03-06T16:00:00Z') // Thu, 10:00 AM in Chicago
const END = new Date('2025-03-06T17:00:00Z')
const NOW = new Date('2025-03-07T16:00:00Z')
const TODAY = '2025-03-07'

type World = Awaited<ReturnType<typeof makeWorld>>

const recapOf = (w: World, meetingId: string) =>
  getRecap(db, meetingId, { today: TODAY, timeZone: ZONE, selfId: w.john.id, now: NOW })

let minute = 0
/** A note on a meeting, with the runs made of it. Notes are stamped in the order they are made. */
async function noteWith(
  meetingId: string,
  ...runs: Array<{
    status: 'queued' | 'running' | 'done' | 'failed'
    output?: RunOutput
    finishedAt?: Date
  }>
) {
  const [note] = await db
    .insert(notes)
    .values({
      meetingId,
      source: 'pasted',
      body: 'x',
      contentHash: randomUUID(),
      createdAt: new Date(START.getTime() + minute++ * 60_000),
    })
    .returning()
  for (const run of runs) {
    await db.insert(processingRuns).values({
      noteId: note!.id,
      contentHash: randomUUID(),
      status: run.status,
      output: run.output ?? null,
      finishedAt: run.finishedAt ?? null,
    })
  }
  return note!
}

const owedShape = (recap: Recap) =>
  recap.owed.map((group) => [group.party?.name ?? null, group.items.map((item) => item.text)])

describe('the committee walkthrough', () => {
  it('a timed agenda, two decisions, three owed items and a milestone, as Markdown', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Retreat committee',
      startsAt: START,
      endsAt: END,
      personIds: [w.sarah.id, w.tom.id],
      projectIds: [w.retreat.id],
    })

    // Before the meeting: two items waiting, placed on a timed agenda.
    const caterer = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'Which caterer?',
      projectId: w.retreat.id,
      parties: [{ personId: w.sarah.id, role: 'owner' }],
    })
    const budget = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'Budget update',
      projectId: w.retreat.id,
    })
    const venue = await addSection(db, actor, meeting.id, { title: 'Venue' })
    await addLine(db, actor, meeting.id, {
      text: 'Compare the two sites',
      sectionId: venue,
      minutes: 20,
      privateNote: 'push back on the price',
    })
    await addLine(db, actor, meeting.id, { itemId: caterer.id, sectionId: venue, minutes: 10 })
    await addLine(db, actor, meeting.id, { itemId: budget.id, minutes: 15, privateNote: 'do not mention the gift' })

    // What the meeting produced.
    for (const text of ["The retreat is at St Mary's", 'Registration closes two weeks before']) {
      await createItem(db, actor, {
        contextId: w.parish.id,
        kind: 'decision',
        text,
        projectId: w.retreat.id,
        originMeetingId: meeting.id,
      })
    }
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Send the deposit',
      dueOn: '2025-03-14',
      projectId: w.retreat.id,
      parties: [{ personId: w.tom.id, role: 'owner' }],
      originMeetingId: meeting.id,
    })
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Draft the schedule',
      parties: [
        { personId: w.john.id, role: 'owner' },
        { groupId: w.staff.id, role: 'with' },
      ],
      originMeetingId: meeting.id,
    })
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'Who drives the minibus?',
      parties: [{ groupId: w.staff.id, role: 'owner' }],
      originMeetingId: meeting.id,
    })
    await completeItem(db, actor, budget.id, { resolution: 'Approved as drafted' })

    await addMilestone(db, { projectId: w.retreat.id, title: 'Registration opens', dueOn: '2025-03-13' })
    await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Retreat planning',
      startsAt: new Date('2025-03-20T15:00:00Z'),
      projectIds: [w.retreat.id],
    })
    await noteWith(meeting.id, {
      status: 'done',
      output: {
        summary: 'Venue settled; deposit and schedule to follow.',
        lines: [{ lineId: venue, summary: "Two sites compared; St Mary's is cheaper." }],
      },
    })

    const recap = await recapOf(w, meeting.id)
    expect(renderRecap(recap)).toBe(
      [
        '# Retreat committee',
        'Thu, Mar 6 · 10:00 AM – 11:00 AM · Sarah Jones, Tom Baker',
        '',
        '## Summary',
        'Venue settled; deposit and schedule to follow.',
        '',
        '## Discussed',
        '- **Venue**',
        "  - Two sites compared; St Mary's is cheaper.",
        '',
        '## Decisions',
        "- The retreat is at St Mary's",
        '- Registration closes two weeks before',
        '',
        '## Follow-ups',
        '',
        '**John**',
        '- Draft the schedule [action]',
        '',
        '**Sarah Jones**',
        '- Which caterer? [question]',
        '',
        '**Staff**',
        '- Who drives the minibus? [question]',
        '',
        '**Tom Baker**',
        '- Send the deposit [action, due Mar 14]',
        '',
        '## Closed',
        '- Budget update — Approved as drafted',
        '',
        '## Lookahead',
        '- Mar 13 · Retreat: Registration opens [milestone]',
        '- Mar 20, 10:00 AM · Retreat planning [meeting]',
      ].join('\n'),
    )

    const html = renderRecapHtml(recap)
    expect(html).toContain('<h1>Retreat committee</h1>')
    expect(html).toContain("<h2>Decisions</h2><ul><li>The retreat is at St Mary's</li>")
    expect(html).toContain('<p><strong>Tom Baker</strong></p><ul><li>Send the deposit [action, due Mar 14]</li></ul>')
    expect(html).toContain("<li><strong>Venue</strong><ul><li>Two sites compared; St Mary's is cheaper.</li></ul></li>")

    // John's private notes go nowhere.
    for (const out of [renderRecap(recap), html, JSON.stringify(recap)]) {
      expect(out).not.toContain('push back')
      expect(out).not.toContain('gift')
    }
  })
})

describe('decisions', () => {
  it('are listed in their own wording, with one recorded afterwards on an item raised here', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      startsAt: START,
      personIds: [w.sarah.id, w.tom.id],
    })
    const question = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'What is the lunch menu?',
      parties: [{ personId: w.sarah.id, role: 'owner' }],
    })
    await placeItem(db, actor, meeting.id, question.id)
    await answerItem(db, actor, question.id, { answer: 'Soup and sandwiches' })
    await recordDecision(db, actor, { fromItemId: question.id, text: 'Lunch is soup and sandwiches' })

    const first = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'decision',
      text: 'Start at nine',
      originMeetingId: meeting.id,
    })
    await supersedeDecision(db, actor, first.id, { text: 'Start at half past nine' })

    // Neither of these was made here.
    await recordDecision(db, actor, { contextId: w.parish.id, text: 'an unrelated decision' })
    const other = await createMeeting(db, actor, { contextId: w.parish.id, startsAt: END, personIds: [w.sarah.id] })
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'decision',
      text: 'decided in private',
      parentItemId: question.id,
      originMeetingId: other.id,
    })

    const recap = await recapOf(w, meeting.id)
    expect(recap.decisions.map((decision) => decision.text)).toEqual([
      'Lunch is soup and sandwiches',
      'Start at half past nine',
    ])
    expect(recap.closed.map((item) => [item.text, item.resolution])).toEqual([
      ['What is the lunch menu?', 'Soup and sandwiches'],
    ])
    expect(renderRecap(recap)).toContain('## Closed\n- What is the lunch menu? — Soup and sandwiches')
  })
})

describe('owed', () => {
  it('groups by person and by group, and a three-owner question is under each of the three', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      startsAt: START,
      personIds: [w.sarah.id, w.tom.id, w.bishop.id],
    })
    const make = (input: Partial<Parameters<typeof createItem>[2]> & { text: string }) =>
      createItem(db, actor, { contextId: w.parish.id, kind: 'action', originMeetingId: meeting.id, ...input })

    await make({
      kind: 'question',
      text: 'lunch menu',
      parties: [w.sarah, w.tom, w.bishop].map((person) => ({ personId: person.id, role: 'owner' as const })),
    })
    await make({ text: 'print the rota', dueOn: '2025-03-01', parties: [{ groupId: w.staff.id, role: 'owner' }] })
    await make({ text: 'call the plumber', parties: [{ personId: w.tom.id, role: 'owner' }] })
    await make({ text: 'nobody took this' })
    // Not owed: a topic, a finished action, a dropped one.
    await make({ kind: 'topic', text: 'a topic', parties: [{ personId: w.tom.id, role: 'owner' }] })
    const done = await make({ text: 'done already', parties: [{ personId: w.tom.id, role: 'owner' }] })
    await completeItem(db, actor, done.id)
    const dropped = await make({ text: 'never mind', parties: [{ personId: w.tom.id, role: 'owner' }] })
    await dropItem(db, actor, dropped.id)

    const recap = await recapOf(w, meeting.id)
    expect(owedShape(recap)).toEqual([
      ['Bishop Wright', ['lunch menu']],
      ['Sarah Jones', ['lunch menu']],
      ['Staff', ['print the rota']],
      ['Tom Baker', ['lunch menu', 'call the plumber']],
      [null, ['nobody took this']],
    ])
    expect(recap.owed[2]!.party).toMatchObject({ type: 'group', id: w.staff.id })
    expect(recap.owed[2]!.items[0]).toMatchObject({ dueOn: '2025-03-01', overdue: true })

    const text = renderRecap(recap)
    expect(text).toContain('**Staff**\n- print the rota [action, due Mar 1, overdue]')
    expect(text).toContain('**Unassigned**\n- nobody took this [action]')
    expect(text).toContain('## Closed\n- done already\n- never mind — dropped')
  })

  it("the snippet is what one party owes, and what John owes them", async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Staff',
      startsAt: START,
      personIds: [w.sarah.id, w.tom.id],
    })
    const make = (input: Partial<Parameters<typeof createItem>[2]> & { text: string }) =>
      createItem(db, actor, { contextId: w.parish.id, kind: 'action', originMeetingId: meeting.id, ...input })
    await make({ text: 'book the hall', dueOn: '2025-03-10', parties: [{ personId: w.sarah.id, role: 'owner' }] })
    await make({
      text: 'send Sarah the figures',
      parties: [
        { personId: w.john.id, role: 'owner' },
        { personId: w.sarah.id, role: 'with' },
      ],
    })
    // Tom owns this and it is raised with Sarah: not owed to her.
    await make({
      text: 'fix the boiler',
      parties: [
        { personId: w.tom.id, role: 'owner' },
        { personId: w.sarah.id, role: 'with' },
      ],
    })
    await make({ kind: 'question', text: 'who locks up?', parties: [{ groupId: w.staff.id, role: 'owner' }] })

    const recap = await recapOf(w, meeting.id)
    expect(renderPersonSnippet(recap, { type: 'person', id: w.sarah.id })).toBe(
      [
        'Staff · Thu, Mar 6',
        '',
        '**Yours**',
        '- book the hall [action, due Mar 10]',
        '',
        '**Owed to you**',
        '- send Sarah the figures [action]',
      ].join('\n'),
    )
    expect(renderPersonSnippet(recap, { type: 'person', id: w.tom.id })).toBe(
      ['Staff · Thu, Mar 6', '', '**Yours**', '- fix the boiler [action]'].join('\n'),
    )
    expect(renderPersonSnippet(recap, { type: 'group', id: w.staff.id })).toBe(
      ['Staff · Thu, Mar 6', '', '**Yours**', '- who locks up? [question]'].join('\n'),
    )
    expect(renderPersonSnippet(recap, { type: 'person', id: w.bishop.id })).toBe('')
  })
})

describe('closed', () => {
  it('only what was closed at or after the meeting', async () => {
    const w = await makeWorld()
    const before = await createItem(db, actor, { contextId: w.parish.id, text: 'closed beforehand' })
    const after = await createItem(db, actor, { contextId: w.parish.id, text: 'closed afterwards' })

    // One meeting long ago, one that has not happened yet.
    const past = await createMeeting(db, actor, { contextId: w.parish.id, startsAt: START, personIds: [w.sarah.id] })
    const future = await createMeeting(db, actor, {
      contextId: w.parish.id,
      startsAt: new Date(Date.now() + 86_400_000),
      personIds: [w.sarah.id],
    })
    await placeItem(db, actor, past.id, after.id)
    await placeItem(db, actor, future.id, before.id)
    await completeItem(db, actor, before.id)
    await completeItem(db, actor, after.id)

    expect((await recapOf(w, past.id)).closed.map((item) => item.text)).toEqual(['closed afterwards'])
    expect((await recapOf(w, future.id)).closed).toEqual([])
  })
})

describe('the summary', () => {
  it('comes from the latest finished run of each note, in note order', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, startsAt: START, personIds: [w.sarah.id] })
    expect((await recapOf(w, meeting.id)).summary).toBeNull()

    await noteWith(
      meeting.id,
      { status: 'done', output: { summary: 'an older reading', lines: [] }, finishedAt: new Date('2025-03-06T18:00:00Z') },
      { status: 'done', output: { summary: 'First half.', lines: [] }, finishedAt: new Date('2025-03-06T19:00:00Z') },
      // A later run of an edited note that failed: the last good one stands.
      { status: 'failed', output: { summary: 'half-written', lines: [] }, finishedAt: new Date('2025-03-06T20:00:00Z') },
    )
    expect((await recapOf(w, meeting.id)).summary).toBe('First half.')

    await noteWith(meeting.id, { status: 'done', output: { summary: 'Second half.\n\n- one\n- two', lines: [] } })
    await noteWith(meeting.id, { status: 'failed' })
    await noteWith(meeting.id, { status: 'queued', output: { summary: 'not yet', lines: [] } })
    await noteWith(meeting.id, { status: 'running' })
    await noteWith(meeting.id, { status: 'done', output: { summary: null, lines: [] } })

    const recap = await recapOf(w, meeting.id)
    expect(recap.summary).toBe('First half.\n\nSecond half.\n\n- one\n- two')
    expect(renderRecap(recap)).toContain('## Summary\nFirst half.\n\nSecond half.\n- one\n- two')
    expect(renderRecapHtml(recap)).toContain(
      '<h2>Summary</h2><p>First half.</p><p>Second half.</p><ul><li>one</li><li>two</li></ul>',
    )
  })

  it('keeps a line summary only while its line is on the agenda, with its public description', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, startsAt: START, personIds: [w.sarah.id] })
    const second = await addLine(db, actor, meeting.id, { text: 'Second', privateNote: 'secret' })
    const first = await addLine(db, actor, meeting.id, { text: 'First', position: 0, description: 'Bring the **map**' })
    const gone = await addLine(db, actor, meeting.id, { text: 'Gone' })
    await noteWith(meeting.id, {
      status: 'done',
      output: {
        summary: null,
        lines: [
          { lineId: second, summary: 'about the second' },
          { lineId: gone, summary: 'about the removed one' },
          { lineId: first, summary: 'about the first' },
          { lineId: randomUUID(), summary: 'about nothing' },
        ],
      },
    })
    await removeLine(db, actor, gone)

    const recap = await recapOf(w, meeting.id)
    expect(recap.lines).toEqual([
      { lineId: first, text: 'First', description: 'Bring the **map**', summary: 'about the first' },
      { lineId: second, text: 'Second', description: null, summary: 'about the second' },
    ])
    expect(renderRecap(recap)).toBe(
      [
        '# Sarah Jones',
        'Thu, Mar 6 · 10:00 AM · Sarah Jones',
        '',
        '## Discussed',
        '- **First**',
        '  - Bring the **map**',
        '  - about the first',
        '- **Second**',
        '  - about the second',
      ].join('\n'),
    )
    expect(renderRecapHtml(recap)).toContain('<li>Bring the <strong>map</strong></li>')
    expect(renderRecapHtml(recap)).not.toContain('secret')
  })
})

describe('sessions', () => {
  it("a meeting's recap takes in its sessions; a session's covers only itself", async () => {
    const w = await makeWorld()
    const parent = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Retreat',
      startsAt: START,
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
    })
    const dayOne = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Day one',
      parentMeetingId: parent.id,
      startsAt: START,
      personIds: [w.sarah.id, w.tom.id],
      projectIds: [w.retreat.id],
    })
    const dayTwo = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Day two',
      parentMeetingId: parent.id,
      startsAt: new Date('2025-03-07T15:00:00Z'),
      personIds: [w.bishop.id],
      projectIds: [w.retreat.id],
    })
    const make = (meetingId: string, text: string, kind: 'action' | 'decision' = 'action') =>
      createItem(db, actor, {
        contextId: w.parish.id,
        kind,
        text,
        originMeetingId: meetingId,
        parties: kind === 'action' ? [{ personId: w.tom.id, role: 'owner' }] : [],
      })
    await make(parent.id, 'from the whole')
    await make(dayOne.id, 'from day one')
    await make(dayTwo.id, 'from day two')
    await make(dayTwo.id, 'decided on day two', 'decision')
    const placed = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'placed on day one',
      parties: [{ personId: w.tom.id, role: 'owner' }],
    })
    await placeItem(db, actor, dayOne.id, placed.id)

    await noteWith(dayTwo.id, { status: 'done', output: { summary: 'Day two.', lines: [] } })
    await noteWith(dayOne.id, { status: 'done', output: { summary: 'Day one.', lines: [] } })
    await noteWith(parent.id, { status: 'done', output: { summary: 'Overall.', lines: [] } })

    const whole = await recapOf(w, parent.id)
    expect(owedShape(whole)).toEqual([
      ['Tom Baker', ['from the whole', 'from day one', 'from day two', 'placed on day one']],
    ])
    expect(whole.decisions.map((decision) => decision.text)).toEqual(['decided on day two'])
    expect(whole.summary).toBe('Overall.\n\nDay one.\n\nDay two.')
    expect(whole.meeting.people.map((person) => person.name)).toEqual(['Bishop Wright', 'Sarah Jones', 'Tom Baker'])
    // Its own sessions are not "next meetings".
    expect(whole.lookahead).toBeNull()

    const one = await recapOf(w, dayOne.id)
    expect(owedShape(one)).toEqual([['Tom Baker', ['from day one', 'placed on day one']]])
    expect(one.decisions).toEqual([])
    expect(one.summary).toBe('Day one.')
    expect(one.meeting.people.map((person) => person.name)).toEqual(['Sarah Jones', 'Tom Baker'])
  })
})

describe('empty sections', () => {
  it('a meeting with nothing to say is its heading and nothing else', async () => {
    const w = await makeWorld()
    const stub = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Catch-up' })
    const recap = await recapOf(w, stub.id)
    expect(recap).toMatchObject({
      summary: null,
      lines: [],
      decisions: [],
      owed: [],
      closed: [],
      lookahead: null,
      recipients: [],
    })
    expect(renderRecap(recap)).toBe('# Catch-up')
    expect(renderRecapHtml(recap)).toBe('<h1>Catch-up</h1>')
    expect(recapMailto(recap)).toBe('mailto:?subject=Recap%3A%20Catch-up')
  })

  it('prints only the sections that have something in them', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, startsAt: START, personIds: [w.tom.id] })
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'decision',
      text: 'Go ahead',
      originMeetingId: meeting.id,
    })
    expect(renderRecap(await recapOf(w, meeting.id))).toBe(
      ['# Tom Baker', 'Thu, Mar 6 · 10:00 AM · Tom Baker', '', '## Decisions', '- Go ahead'].join('\n'),
    )
  })
})

describe('the mailto', () => {
  it('has the attendees’ primary addresses, an encoded subject and no body', async () => {
    const w = await makeWorld()
    const amy = await createPerson(db, { name: "Amy O'Neil", email: 'amy+parish@example.test' })
    // Sarah has a second address; Tom has none; John's own is never a recipient.
    await db.insert(personEmails).values({ personId: w.sarah.id, email: 'sarah.old@example.test' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Budget & plans: Q2?',
      startsAt: START,
      personIds: [w.sarah.id, w.tom.id, amy.id, w.john.id],
    })

    const recap = await recapOf(w, meeting.id)
    expect(recap.recipients).toEqual([
      { personId: amy.id, name: "Amy O'Neil", email: 'amy+parish@example.test' },
      { personId: w.sarah.id, name: 'Sarah Jones', email: 'sarah@example.test' },
    ])
    const url = recapMailto(recap)
    expect(url).toBe(
      'mailto:amy%2Bparish@example.test,sarah@example.test?subject=Recap%3A%20Budget%20%26%20plans%3A%20Q2%3F%2C%20Mar%206',
    )
    expect(url).not.toContain('body=')
    expect(new URL(url).searchParams.get('subject')).toBe('Recap: Budget & plans: Q2?, Mar 6')

    // When the primary changes, so does the recipient.
    await db.update(personEmails).set({ isPrimary: false }).where(eq(personEmails.personId, w.sarah.id))
    await db
      .update(personEmails)
      .set({ isPrimary: true })
      .where(eq(personEmails.email, 'sarah.old@example.test'))
    expect((await recapOf(w, meeting.id)).recipients[1]!.email).toBe('sarah.old@example.test')
  })
})

describe('dates', () => {
  it("are on the user's clock, not the server's", async () => {
    const w = await makeWorld()
    // 02:30 UTC on the 7th is the evening of the 6th in Chicago.
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Evening',
      startsAt: new Date('2025-03-07T02:30:00Z'),
    })
    const recap = await recapOf(w, meeting.id)
    expect(renderRecap(recap)).toBe('# Evening\nThu, Mar 6 · 8:30 PM')
    expect(recapMailto(recap)).toContain('Mar%206')
  })
})
