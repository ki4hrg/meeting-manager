import { describe, expect, it } from 'vitest'
import { ValidationError } from '../lib/core/types'
import {
  addItemParty,
  addNote,
  answerItem,
  answered,
  askItem,
  askOf,
  completeItem,
  convertItem,
  createItem,
  deleteItem,
  dropItem,
  getItem,
  getThread,
  isAnswered,
  listItems,
  openCounts,
  parkItem,
  recordAnswered,
  recordDecision,
  reopenItem,
  setItemParties,
  setOngoing,
  supersedeDecision,
  undropItem,
  unparkItem,
  updateItem,
} from '../lib/items/items'
import { addDays } from '../lib/core/dates'
import { listContexts } from '../lib/directory/contexts'
import { isLater } from '../lib/items/horizon'
import { owedEverywhere } from '../lib/today'
import { itemEvents } from '../lib/db/schema'
import { createMeeting } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { eq } from 'drizzle-orm'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('creating', () => {
  it('needs only a context and text, and lands in the inbox as a topic', async () => {
    const { parish, diocese } = await makeWorld()
    const item = await createItem(db, actor, { contextId: parish.id, text: '  Look at the roof  ' })

    expect(item).toMatchObject({ kind: 'topic', status: 'open', text: 'Look at the roof' })
    expect((await listItems(db, { contextId: parish.id, inbox: true })).map((i) => i.id)).toEqual([
      item.id,
    ])
    expect(await listItems(db, { contextId: diocese.id })).toEqual([])
    expect((await openCounts(db, parish.id)).inbox).toBe(1)
  })

  it('leaves the inbox once it has a party or a project', async () => {
    const { parish, sarah, retreat } = await makeWorld()
    const a = await createItem(db, actor, { contextId: parish.id, text: 'one' })
    const b = await createItem(db, actor, { contextId: parish.id, text: 'two' })

    await setItemParties(db, actor, a.id, [{ personId: sarah.id, role: 'with' }])
    await updateItem(db, actor, b.id, { projectId: retreat.id })

    expect(await listItems(db, { contextId: parish.id, inbox: true })).toEqual([])
    const counts = await openCounts(db, parish.id)
    expect(counts.byPerson.get(sarah.id)).toBe(1)
    expect(counts.byProject.get(retreat.id)).toBe(1)
  })

  it('refuses empty text and a bad date', async () => {
    const { parish } = await makeWorld()
    await expect(createItem(db, actor, { contextId: parish.id, text: ' ' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(
      createItem(db, actor, { contextId: parish.id, text: 'x', dueOn: '2026-02-31' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('context boundary', () => {
  it('refuses a project, group or parent from another context', async () => {
    const { parish, diocese, synod, council } = await makeWorld()

    await expect(
      createItem(db, actor, { contextId: parish.id, text: 'x', projectId: synod.id }),
    ).rejects.toThrow('another context')
    await expect(
      createItem(db, actor, {
        contextId: parish.id,
        text: 'x',
        parties: [{ groupId: council.id, role: 'owner' }],
      }),
    ).rejects.toThrow('another context')

    const there = await createItem(db, actor, { contextId: diocese.id, text: 'over there' })
    await expect(
      createItem(db, actor, { contextId: parish.id, text: 'x', parentItemId: there.id }),
    ).rejects.toBeInstanceOf(ValidationError)

    const here = await createItem(db, actor, { contextId: parish.id, text: 'here' })
    await expect(updateItem(db, actor, here.id, { projectId: synod.id })).rejects.toThrow(
      'another context',
    )
  })

  it('lists a person\'s items one context at a time', async () => {
    const { parish, diocese, bishop } = await makeWorld()
    await createItem(db, actor, {
      contextId: parish.id,
      text: 'parish matter',
      parties: [{ personId: bishop.id, role: 'with' }],
    })
    await createItem(db, actor, {
      contextId: diocese.id,
      text: 'diocese matter',
      parties: [{ personId: bishop.id, role: 'with' }],
    })

    const inParish = await listItems(db, { contextId: parish.id, party: { personId: bishop.id } })
    expect(inParish.map((i) => i.text)).toEqual(['parish matter'])
  })
})

describe('lifecycle', () => {
  it('converts in place, keeping the record', async () => {
    const { parish } = await makeWorld()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'The lunch menu' })

    const question = await convertItem(db, actor, item.id, 'question')
    expect(question).toMatchObject({ id: item.id, kind: 'question', status: 'open' })

    await expect(convertItem(db, actor, item.id, 'decision')).rejects.toThrow('its own record')
  })

  it('closes a question only with an answer', async () => {
    const { parish } = await makeWorld()
    const q = await createItem(db, actor, { contextId: parish.id, kind: 'question', text: 'Menu?' })

    await expect(completeItem(db, actor, q.id)).rejects.toThrow('answer')
    await expect(answerItem(db, actor, q.id, { answer: ' ' })).rejects.toBeInstanceOf(ValidationError)

    const { item } = await answerItem(db, actor, q.id, { answer: 'Tacos' })
    expect(item).toMatchObject({ kind: 'question', status: 'done', resolution: 'Tacos' })
    expect(item.closedAt).not.toBeNull()
  })

  it('completes, drops and reopens', async () => {
    const { parish } = await makeWorld()
    const action = await createItem(db, actor, { contextId: parish.id, kind: 'action', text: 'Send it' })

    expect((await completeItem(db, actor, action.id)).status).toBe('done')
    await expect(dropItem(db, actor, action.id)).rejects.toThrow('already closed')
    expect(await reopenItem(db, actor, action.id)).toMatchObject({ status: 'open', closedAt: null })
    expect((await dropItem(db, actor, action.id)).status).toBe('dropped')
  })

  it('undoes a drop as if it never happened, but only while nothing has happened since', async () => {
    const { parish } = await makeWorld()
    const later = await createItem(db, actor, { contextId: parish.id, text: 'Someday' })
    await parkItem(db, actor, later.id, { until: '2026-11-01' })
    const history = async () =>
      (await db.select().from(itemEvents).where(eq(itemEvents.itemId, later.id))).map((event) => event.type).sort()
    const before = await history()

    await dropItem(db, actor, later.id)
    expect(await undropItem(db, actor, later.id)).toMatchObject({ status: 'open', closedAt: null, laterOn: '2026-11-01' })
    expect((await getItem(db, later.id)).parkedAt).not.toBeNull()
    expect(await history()).toEqual(before)

    // Once something else has happened, it is reopened from its page instead.
    await dropItem(db, actor, later.id)
    await addNote(db, actor, later.id, 'gone for good')
    await expect(undropItem(db, actor, later.id)).rejects.toThrow('changed since it was dropped')
    await reopenItem(db, actor, later.id)
    await expect(undropItem(db, actor, later.id)).rejects.toThrow('changed since it was dropped')
  })

  it('deletes a closed item that stands alone, and refuses an open one or one in a thread', async () => {
    const { parish } = await makeWorld()
    const mistake = await createItem(db, actor, { contextId: parish.id, text: 'test' })
    await expect(deleteItem(db, actor, mistake.id)).rejects.toThrow('done or drop it first')
    await dropItem(db, actor, mistake.id)
    await deleteItem(db, actor, mistake.id)
    await expect(getItem(db, mistake.id)).rejects.toThrow()
    expect(await listItems(db, { contextId: parish.id })).toEqual([])

    const parent = await createItem(db, actor, { contextId: parish.id, text: 'the first' })
    const child = await createItem(db, actor, { contextId: parish.id, text: 'the next', parentItemId: parent.id })
    await dropItem(db, actor, parent.id)
    await dropItem(db, actor, child.id)
    await expect(deleteItem(db, actor, parent.id)).rejects.toThrow('part of the record')
    await expect(deleteItem(db, actor, child.id)).rejects.toThrow('part of the record')
    expect((await getItem(db, parent.id)).status).toBe('dropped')
  })

  it('keeps a decision out of the open states', async () => {
    const { parish } = await makeWorld()
    const { item: decision } = await recordDecision(db, actor, {
      contextId: parish.id,
      text: 'The retreat moves to May',
    })

    expect(decision).toMatchObject({ kind: 'decision', status: 'decided' })
    await expect(dropItem(db, actor, decision.id)).rejects.toBeInstanceOf(ValidationError)
    await expect(convertItem(db, actor, decision.id, 'topic')).rejects.toBeInstanceOf(ValidationError)

    const replacement = await supersedeDecision(db, actor, decision.id, { text: 'It moves to June' })
    expect(await getItem(db, decision.id)).toMatchObject({
      status: 'superseded',
      supersededByItemId: replacement.id,
    })
    await expect(
      supersedeDecision(db, actor, decision.id, { text: 'again' }),
    ).rejects.toThrow('already been superseded')
  })
})

describe('later', () => {
  it('parks an open item with or without a day, and brings it back', async () => {
    const { parish } = await makeWorld()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'Reimagine the journal' })

    const parked = await parkItem(db, actor, item.id)
    expect(parked.parkedAt).toBeInstanceOf(Date)
    expect(parked.laterOn).toBeNull()

    const dated = await parkItem(db, actor, item.id, { until: '2027-01-04' })
    expect(dated.laterOn).toBe('2027-01-04')
    expect(dated.parkedAt).toEqual(parked.parkedAt)

    const back = await unparkItem(db, actor, item.id)
    expect(back).toMatchObject({ parkedAt: null, laterOn: null })

    const types = (await getThread(db, item.id)).events.map((event) => event.type)
    expect(types).toEqual(['created', 'parked', 'parked', 'unparked'])
  })

  it('is cleared when the item closes, and refused on a closed item', async () => {
    const { parish } = await makeWorld()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'Christmas lunch', kind: 'action' })
    await parkItem(db, actor, item.id, { until: '2026-12-01' })
    await completeItem(db, actor, item.id)
    expect(await getItem(db, item.id)).toMatchObject({ parkedAt: null, laterOn: null })

    await expect(parkItem(db, actor, item.id)).rejects.toBeInstanceOf(ValidationError)
    const reopened = await reopenItem(db, actor, item.id)
    expect(reopened.parkedAt).toBeNull()
  })

  it('refuses a bad day', async () => {
    const { parish } = await makeWorld()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'x' })
    await expect(parkItem(db, actor, item.id, { until: 'soon' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('later, until another item is done', () => {
  const TODAY = '2026-10-04'

  async function emailAndSurvey() {
    const w = await makeWorld()
    const mine = { parties: [{ personId: w.john.id, role: 'owner' as const }] }
    const survey = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Put together a post-event survey',
      ...mine,
    })
    const email = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Send post-event email',
      ...mine,
    })
    return { ...w, survey, email }
  }

  const owed = async (selfId: string) => owedEverywhere(db, await listContexts(db), selfId, TODAY)

  it('leaves I owe, and is back in the same commit that closes what it waits on, with history on both', async () => {
    const { survey, email } = await emailAndSurvey()
    const parked = await parkItem(db, actor, email.id, { untilItem: survey.id })
    expect(parked).toMatchObject({ laterUntilItemId: survey.id, laterOn: null })
    expect(isLater(parked, TODAY)).toBe(true)
    expect((await listItems(db, { contextId: email.contextId, waitingOn: survey.id })).map((i) => i.id)).toEqual([
      email.id,
    ])

    // Parking again for a day keeps what it waits on.
    expect((await parkItem(db, actor, email.id, { until: '2027-01-04' })).laterUntilItemId).toBe(survey.id)

    await completeItem(db, actor, survey.id)
    expect(await getItem(db, email.id)).toMatchObject({ parkedAt: null, laterOn: null, laterUntilItemId: null })
    expect(isLater(await getItem(db, email.id), TODAY)).toBe(false)

    const events = (await getThread(db, email.id)).events
    const back = events.at(-1)!
    expect(back).toMatchObject({ type: 'unparked', data: { itemId: survey.id, text: survey.text } })
    expect(events.filter((event) => event.type === 'parked')[0]!.data).toEqual({ untilItem: survey.id })
    const done = (await getThread(db, survey.id)).events.find((event) => event.type === 'completed')
    expect(done?.data).toEqual({ released: [{ id: email.id, text: email.text }] })
  })

  it('is back when what it waits on is answered or dropped, too', async () => {
    const { parish, survey, email } = await emailAndSurvey()
    const question = await createItem(db, actor, { contextId: parish.id, kind: 'question', text: 'Which venue?' })
    await parkItem(db, actor, email.id, { untilItem: question.id })
    await answerItem(db, actor, question.id, { answer: 'The hall' })
    expect((await getItem(db, email.id)).parkedAt).toBeNull()

    await parkItem(db, actor, email.id, { untilItem: survey.id })
    await dropItem(db, actor, survey.id)
    expect(await getItem(db, email.id)).toMatchObject({ parkedAt: null, laterUntilItemId: null })
  })

  it('a deadline coming close brings it back while it still waits', async () => {
    const { john, survey, email } = await emailAndSurvey()
    await updateItem(db, actor, email.id, { dueOn: addDays(TODAY, 3) })
    await parkItem(db, actor, email.id, { untilItem: survey.id })
    const now = await owed(john.id)
    expect(now.later.mine.map((item) => item.id)).not.toContain(email.id)
    expect(now.due.concat(now.mine).map((item) => item.id)).toContain(email.id)
    expect((await getItem(db, email.id)).laterUntilItemId).toBe(survey.id)
  })

  it('refuses itself, another context, a closed item and a missing one; null stops the wait', async () => {
    const { diocese, survey, email } = await emailAndSurvey()
    await expect(parkItem(db, actor, email.id, { untilItem: email.id })).rejects.toThrow('wait on itself')
    const elsewhere = await createItem(db, actor, { contextId: diocese.id, text: 'synod paper' })
    await expect(parkItem(db, actor, email.id, { untilItem: elsewhere.id })).rejects.toThrow('another context')
    const closed = await createItem(db, actor, { contextId: email.contextId, kind: 'action', text: 'old' })
    await completeItem(db, actor, closed.id)
    await expect(parkItem(db, actor, email.id, { untilItem: closed.id })).rejects.toThrow('already closed')
    expect((await getItem(db, email.id)).parkedAt).toBeNull()

    await parkItem(db, actor, email.id, { untilItem: survey.id })
    expect((await parkItem(db, actor, email.id, { untilItem: null })).laterUntilItemId).toBeNull()
  })

  it('two items waiting on each other both stay parked until one closes', async () => {
    const { survey, email } = await emailAndSurvey()
    await parkItem(db, actor, email.id, { untilItem: survey.id })
    await parkItem(db, actor, survey.id, { untilItem: email.id })
    expect((await getItem(db, email.id)).parkedAt).not.toBeNull()
    expect((await getItem(db, survey.id)).parkedAt).not.toBeNull()
    await completeItem(db, actor, survey.id)
    expect((await getItem(db, email.id)).parkedAt).toBeNull()
  })

  it('undoing a drop puts the wait back while what it waited on is still open', async () => {
    const { survey, email } = await emailAndSurvey()
    await parkItem(db, actor, email.id, { untilItem: survey.id })
    await dropItem(db, actor, email.id)
    expect((await undropItem(db, actor, email.id)).laterUntilItemId).toBe(survey.id)

    await dropItem(db, actor, email.id)
    await completeItem(db, actor, survey.id)
    expect(await undropItem(db, actor, email.id)).toMatchObject({ parkedAt: null, laterUntilItemId: null })
  })
})

describe('threads', () => {
  it('follows topic to question to answer to decision to action on one thread', async () => {
    const { parish, retreat, sarah } = await makeWorld()
    const topic = await createItem(db, actor, {
      contextId: parish.id,
      text: 'What is the lunch menu?',
      projectId: retreat.id,
    })
    await convertItem(db, actor, topic.id, 'question')
    await addNote(db, actor, topic.id, 'Sarah is asking the caterer')
    await answerItem(db, actor, topic.id, { answer: 'Tacos, with a vegetarian option' })

    const { item: decision } = await recordDecision(db, actor, {
      fromItemId: topic.id,
      text: 'Lunch at the retreat is tacos',
    })
    // The decision has its own wording and inherits the project.
    expect(decision).toMatchObject({ parentItemId: topic.id, text: 'Lunch at the retreat is tacos' })
    expect(decision.project?.id).toBe(retreat.id)
    // The question is still a question.
    expect((await getItem(db, topic.id)).kind).toBe('question')

    const action = await createItem(db, actor, {
      contextId: parish.id,
      kind: 'action',
      text: 'Book the caterer',
      parentItemId: decision.id,
      parties: [{ personId: sarah.id, role: 'owner' }],
    })

    // The same thread from any item in it.
    for (const id of [topic.id, decision.id, action.id]) {
      const thread = await getThread(db, id)
      expect(thread.entries.map((e) => [e.item.id, e.depth])).toEqual([
        [topic.id, 0],
        [decision.id, 1],
        [action.id, 2],
      ])
    }

    const { events } = await getThread(db, topic.id)
    expect(events.filter((e) => e.itemId === topic.id).map((e) => e.type)).toEqual([
      'created',
      'converted',
      'note',
      'answered',
      'spawned',
    ])
  })

  it('reports an answer back to another group as a topic of its own', async () => {
    const { parish, staff, bishop } = await makeWorld()
    const q = await createItem(db, actor, {
      contextId: parish.id,
      kind: 'question',
      text: 'Can we use the hall in May?',
      parties: [{ personId: bishop.id, role: 'owner' }],
    })

    const { report } = await answerItem(db, actor, q.id, {
      answer: 'Yes, any weekend but the 16th',
      reportTo: { groupId: staff.id },
    })

    expect(report).toMatchObject({
      kind: 'topic',
      status: 'open',
      parentItemId: q.id,
      detail: 'Yes, any weekend but the 16th',
    })
    expect(report!.parties).toMatchObject([{ type: 'group', id: staff.id, role: 'with' }])

    const waiting = await listItems(db, {
      contextId: parish.id,
      open: true,
      party: { groupId: staff.id, role: 'with' },
    })
    expect(waiting.map((i) => i.id)).toEqual([report!.id])
  })

  it('holds one question owned by three', async () => {
    const { parish, john, sarah, tom } = await makeWorld()
    const q = await createItem(db, actor, {
      contextId: parish.id,
      kind: 'question',
      text: 'What is the lunch menu?',
      parties: [john, sarah, tom].map((p) => ({ personId: p.id, role: 'owner' as const })),
    })
    expect(q.parties.map((p) => p.name)).toEqual(['John', 'Sarah Jones', 'Tom Baker'])
    expect(q.parties[0]!.isSelf).toBe(true)

    await expect(
      setItemParties(db, actor, q.id, [
        { personId: sarah.id, role: 'owner' },
        { personId: sarah.id, role: 'with' },
      ]),
    ).rejects.toThrow('twice')
  })
})

describe('changing a party\'s role', () => {
  it('moves one party in place, keeps collaborators after the lead, and records one role change', async () => {
    const { parish, john, sarah, tom } = await makeWorld()
    const action = await createItem(db, actor, {
      contextId: parish.id,
      kind: 'action',
      text: 'Book the hall',
      parties: [
        { personId: john.id, role: 'owner' },
        { personId: sarah.id, role: 'with' },
        { personId: tom.id, role: 'with' },
      ],
    })
    const owners = async () =>
      (await getItem(db, action.id)).parties.filter((p) => p.role === 'owner').map((p) => p.name)
    const roles = async () =>
      (await db.select().from(itemEvents).where(eq(itemEvents.itemId, action.id)))
        .filter((event) => event.type === 'role')
        .map((event) => event.data)

    // To owner while there is one: a collaborator, after the lead.
    await addItemParty(db, actor, action.id, { personId: sarah.id, role: 'owner' })
    expect(await owners()).toEqual(['John', 'Sarah Jones'])
    // Made lead: first among the owners.
    await addItemParty(db, actor, action.id, { personId: tom.id, role: 'owner' }, { lead: true })
    expect(await owners()).toEqual(['Tom Baker', 'John', 'Sarah Jones'])
    // The lead made a collaborator: to the end, and the next owner leads.
    await addItemParty(db, actor, action.id, { personId: tom.id, role: 'owner' }, { lead: false })
    expect(await owners()).toEqual(['John', 'Sarah Jones', 'Tom Baker'])
    // Back to who it is for.
    await addItemParty(db, actor, action.id, { personId: sarah.id, role: 'with' })
    expect(await owners()).toEqual(['John', 'Tom Baker'])
    // Already there in that role: nothing changes, nothing is recorded.
    await addItemParty(db, actor, action.id, { personId: john.id, role: 'owner' })

    const item = await getItem(db, action.id)
    expect(item.parties).toHaveLength(3)
    expect(await roles()).toEqual([
      { name: 'Sarah Jones', role: 'owner', collaborator: true },
      { name: 'Tom Baker', role: 'owner', collaborator: false },
      { name: 'Tom Baker', role: 'owner', collaborator: true },
      { name: 'Sarah Jones', role: 'with', collaborator: false },
    ])
    const events = await db.select().from(itemEvents).where(eq(itemEvents.itemId, action.id))
    expect(events.filter((event) => event.type === 'parties')).toHaveLength(0)
  })

  it('adds someone new as a change of people', async () => {
    const { parish, sarah } = await makeWorld()
    const question = await createItem(db, actor, { contextId: parish.id, kind: 'question', text: 'Who has the key?' })
    await addItemParty(db, actor, question.id, { personId: sarah.id, role: 'owner' })
    const events = await db.select().from(itemEvents).where(eq(itemEvents.itemId, question.id))
    expect(events.map((event) => event.type)).toContain('parties')
    expect(events.map((event) => event.type)).not.toContain('role')
  })
})

describe("a series' answered questions", () => {
  it('are the ones raised at its meetings or their sessions, or aimed at it, and answered', async () => {
    const { parish } = await makeWorld()
    const staff = await createSeries(db, { contextId: parish.id, name: 'Staff' })
    const other = await createSeries(db, { contextId: parish.id, name: 'Vestry' })
    const meeting = await createMeeting(db, actor, { contextId: parish.id, seriesId: staff.id, title: 'Staff' })
    const session = await createMeeting(db, actor, { contextId: parish.id, parentMeetingId: meeting.id, title: 'Breakout' })
    const elsewhere = await createMeeting(db, actor, { contextId: parish.id, seriesId: other.id, title: 'Vestry' })

    const ask = async (text: string, more: object) => {
      const item = await createItem(db, actor, { contextId: parish.id, kind: 'question', text, ...more })
      return item
    }
    const raised = await ask('Raised there', { originMeetingId: meeting.id })
    const inSession = await ask('In a session', { originMeetingId: session.id })
    const aimed = await ask('Aimed at it', { target: { seriesId: staff.id } })
    const open = await ask('Still open', { originMeetingId: meeting.id })
    const vestry = await ask('Elsewhere', { originMeetingId: elsewhere.id })
    for (const item of [raised, inSession, aimed, vestry]) await answerItem(db, actor, item.id, { answer: 'Yes' })

    const ofStaff = await listItems(db, { contextId: parish.id, seriesId: staff.id })
    expect(answered(ofStaff).map((i) => i.text).sort()).toEqual(['Aimed at it', 'In a session', 'Raised there'])
    expect(ofStaff.map((i) => i.id)).toContain(open.id)
    expect(isAnswered(ofStaff.find((i) => i.id === open.id)!)).toBe(false)
  })
})

describe('recording an answered question', () => {
  it('asks and answers it at once, and refuses one without its answer', async () => {
    const { parish, retreat } = await makeWorld()
    const item = await recordAnswered(db, actor, { contextId: parish.id, text: 'Where do we stay?', answer: 'The abbey', projectId: retreat.id })
    expect(item).toMatchObject({ kind: 'question', status: 'done', resolution: 'The abbey' })
    expect(item.project?.id).toBe(retreat.id)
    await expect(
      recordAnswered(db, actor, { contextId: parish.id, text: 'When?', answer: '  ', projectId: retreat.id }),
    ).rejects.toThrow('Enter the answer.')
    expect((await listItems(db, { contextId: parish.id })).map((i) => i.text)).toEqual(['Where do we stay?'])
  })
})

describe('asking', () => {
  async function owed() {
    const w = await makeWorld()
    const question = (text: string) =>
      createItem(db, actor, {
        contextId: w.parish.id,
        kind: 'question',
        text,
        projectId: w.retreat.id,
        parties: [{ personId: w.bishop.id, role: 'owner' }],
      })
    return { w, question }
  }

  it('makes John an action to ask, in the question’s thread, and parks the question on it', async () => {
    const { w, question } = await owed()
    const scripture = await question('Closing scripture?')
    const { question: after, ask } = await askItem(db, actor, scripture.id, {
      with: { personId: w.sarah.id },
      dueOn: '2026-10-30',
    })

    expect(ask).toMatchObject({
      kind: 'action',
      text: 'Ask Bishop Wright: Closing scripture?',
      parentItemId: scripture.id,
      dueOn: '2026-10-30',
      project: { id: w.retreat.id },
    })
    expect(ask.parties.map((party) => [party.name, party.role])).toEqual([
      ['John', 'owner'],
      ['Sarah Jones', 'with'],
    ])
    expect(after.laterUntilItemId).toBe(ask.id)
    expect((await getThread(db, scripture.id)).entries.map((entry) => entry.item.id)).toContain(ask.id)
  })

  it('joins an open action, and ticking it brings every question back', async () => {
    const { question } = await owed()
    const first = await question('Which Sunday?')
    const second = await question('Who preaches?')
    const { ask } = await askItem(db, actor, first.id, { text: 'Email the bishop' })
    await askItem(db, actor, second.id, { join: ask.id })
    expect((await askOf(db, await getItem(db, first.id)))?.shared).toBe(true)

    await completeItem(db, actor, ask.id)
    expect((await getItem(db, first.id)).parkedAt).toBeNull()
    expect((await getItem(db, second.id)).parkedAt).toBeNull()
  })

  it('refuses a question John owes, one with no one to ask, and a join onto a closed item', async () => {
    const { w, question } = await owed()
    const mine = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'Mine',
      parties: [{ personId: w.john.id, role: 'owner' }],
    })
    await expect(askItem(db, actor, mine.id)).rejects.toThrow('Say who it is asked of first.')
    const closed = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Done' })
    await completeItem(db, actor, closed.id)
    const scripture = await question('Closing scripture?')
    await expect(askItem(db, actor, scripture.id, { join: closed.id })).rejects.toThrow(
      'A question joins an open action.',
    )
  })

  it('answered before it was asked: closes the ask, and records a decision with it', async () => {
    const { question } = await owed()
    const sunday = await question('Which Sunday?')
    const { ask } = await askItem(db, actor, sunday.id)
    const { item, decision } = await answerItem(db, actor, sunday.id, {
      answer: 'The 17th',
      closeAsk: true,
      toldThem: true,
      decision: { text: 'Confirmation is on 17 May' },
    })

    expect(item.status).toBe('done')
    expect((await getItem(db, ask.id)).status).toBe('done')
    expect(decision).toMatchObject({ kind: 'decision', parentItemId: sunday.id, text: 'Confirmation is on 17 May' })
    const [answered] = (await getThread(db, sunday.id)).events.filter((event) => event.type === 'answered')
    expect(answered?.data).toMatchObject({ answer: 'The 17th', told: true })
  })
})

describe('ongoing questions', () => {
  it('turns on and off on an open question only, and converting clears it', async () => {
    const { parish } = await makeWorld()
    const dates = await createItem(db, actor, { contextId: parish.id, kind: 'question', text: '2028 dates?' })
    expect((await setOngoing(db, actor, dates.id, true)).ongoing).toBe(true)
    expect((await setOngoing(db, actor, dates.id, false)).ongoing).toBe(false)

    const topic = await createItem(db, actor, { contextId: parish.id, text: 'Pilgrimage' })
    await expect(setOngoing(db, actor, topic.id, true)).rejects.toThrow('Only a question is ongoing.')

    await setOngoing(db, actor, dates.id, true)
    expect((await convertItem(db, actor, dates.id, 'topic')).ongoing).toBe(false)

    // Asked for on another kind, it is not ongoing.
    const action = await createItem(db, actor, { contextId: parish.id, kind: 'action', text: 'Book', ongoing: true })
    expect(action.ongoing).toBe(false)

    const answered = await createItem(db, actor, { contextId: parish.id, kind: 'question', text: 'Done?' })
    await answerItem(db, actor, answered.id, { answer: 'Yes' })
    await expect(setOngoing(db, actor, answered.id, true)).rejects.toThrow('Reopen this question first.')
  })
})
