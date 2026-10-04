import { describe, expect, it } from 'vitest'
import { ValidationError } from '../lib/core/types'
import {
  addNote,
  answerItem,
  completeItem,
  convertItem,
  createItem,
  deleteItem,
  dropItem,
  getItem,
  getThread,
  listItems,
  openCounts,
  parkItem,
  recordDecision,
  reopenItem,
  setItemParties,
  supersedeDecision,
  undropItem,
  unparkItem,
  updateItem,
} from '../lib/items/items'
import { itemEvents } from '../lib/db/schema'
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
