import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archive, unarchive } from '../lib/archive/archive'
import { itemComments } from '../lib/connect/todoist/comments'
import { bindTodoistProject, todoistConnection } from '../lib/connect/todoist/connection'
import { itemTodoist, linkItem, openTasks, rankTasks, sendItem, skipItem, unmatchedItemIds } from '../lib/connect/todoist/match'
import { syncTodoist } from '../lib/connect/todoist/sync'
import { receiveTodoistDelivery } from '../lib/connect/todoist/webhook'
import { connections, integrationEvents, itemEvents, itemTodoistLinks, todoistComments } from '../lib/db/schema'
import { createProject } from '../lib/projects/projects'
import {
  answerItem,
  askItem,
  completeItem,
  convertItem,
  createItem,
  deleteItem,
  dropItem,
  getItem,
  parkItem,
  removeItemParty,
  reopenItem,
  setOngoing,
  takeBackItem,
  updateItem,
  type PartyInput,
} from '../lib/items/items'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
import { connect, delivery, fakeTodoist } from './helpers/todoist'

resetBetweenTests()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function world() {
  const w = await makeWorld()
  const mine = (personId = w.john.id): PartyInput[] => [{ personId, role: 'owner' }]
  const action = (text: string, extra: Partial<Parameters<typeof createItem>[2]> = {}) =>
    createItem(db, actor, { contextId: w.parish.id, kind: 'action', text, parties: mine(), ...extra })
  return { ...w, mine, action }
}

async function link(itemId: string) {
  const [row] = await db
    .select()
    .from(itemTodoistLinks)
    .where(eq(itemTodoistLinks.itemId, itemId))
  return row
}

describe('connecting', () => {
  it('sets aside what is already open, and sends what comes after', async () => {
    const fake = fakeTodoist()
    const w = await world()
    const before = await w.action('Book the hall')
    const result = await connect()
    expect(result.unmatched).toBe(1)

    const after = await w.action('Print the programme')
    await syncTodoist(db)

    expect(fake.byContent('Book the hall')).toBeUndefined()
    expect(fake.byContent('Print the programme')).toBeDefined()
    expect(await unmatchedItemIds(db)).toEqual([before.id])
    expect((await link(after.id))?.state).toBe('linked')
  })

  it('reads every open task into the cache', async () => {
    const fake = fakeTodoist()
    fake.add('Call the plumber')
    await world()
    await connect()
    expect((await openTasks(db)).map((task) => task.content)).toEqual(['Call the plumber'])
  })
})

describe('what syncs', () => {
  it('follows John as an owner, whatever groups own it with him', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const { addMember } = await import('../lib/directory/groups')
    await addMember(db, w.staff.id, w.john.id)

    await w.action('With his group', { parties: [{ personId: w.john.id, role: 'owner' }, { groupId: w.staff.id, role: 'owner' }] })
    const other = await (await import('../lib/directory/groups')).createGroup(db, { contextId: w.parish.id, name: 'Wardens' })
    await w.action('With another group', { parties: [{ personId: w.john.id, role: 'owner' }, { groupId: other.id, role: 'owner' }] })
    await w.action('His group alone', { parties: [{ groupId: w.staff.id, role: 'owner' }] })
    await w.action('Someone else', { parties: [{ personId: w.sarah.id, role: 'owner' }] })
    await w.action('Owed to him', { parties: [{ personId: w.sarah.id, role: 'owner' }, { personId: w.john.id, role: 'with' }] })
    await createItem(db, actor, { contextId: w.parish.id, kind: 'topic', text: 'A topic', parties: w.mine() })
    await createItem(db, actor, { contextId: w.parish.id, kind: 'question', text: 'A question?', parties: w.mine() })
    await syncTodoist(db)

    expect([...fake.tasks.values()].map((task) => task.content).sort()).toEqual([
      'A question?',
      'With another group',
      'With his group',
    ])
  })

  it('sends the deadline and no scheduled date: when to work on it is John’s to set', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()

    const parked = await w.action('Later thing', { dueOn: '2026-12-01' })
    await parkItem(db, actor, parked.id, { until: '2026-11-15' })
    await w.action('Now thing')
    await w.action('Dated thing', { dueOn: '2026-10-20' })
    await syncTodoist(db, new Date('2026-10-19T03:30:00Z'))

    expect(fake.byContent('Now thing')?.due).toBeNull()
    expect(fake.byContent('Now thing')?.deadline).toBeNull()
    expect(fake.byContent('Dated thing')?.due).toBeNull()
    expect(fake.byContent('Dated thing')?.deadline).toEqual({ date: '2026-10-20' })
    expect(fake.byContent('Later thing')?.due).toBeNull()
    expect(fake.byContent('Later thing')?.deadline).toEqual({ date: '2026-12-01' })
    expect(fake.byContent('Now thing')?.description).toContain('https://meetings.example.test/items/')
  })

  it('puts the item’s detail above the link in the task’s description', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()

    await w.action('Email Jo Dennis', { detail: 'Ask for David as host.' })
    await syncTodoist(db, new Date('2026-10-19T03:30:00Z'))

    expect(fake.byContent('Email Jo Dennis')?.description).toMatch(
      /^Ask for David as host\.\n\n\[Meeting Manager\]\(https:\/\/meetings\.example\.test\/items\//,
    )
  })

  it('sends a task to its project’s binding, an ancestor’s, the context’s, or the Inbox', async () => {
    const fake = fakeTodoist()
    const w = await world()
    const { connection } = await connect()
    const child = await createProject(db, { contextId: w.parish.id, name: 'Retreat music', parentId: w.retreat.id })
    await bindTodoistProject(db, { connectionId: connection.id, todoistProjectId: 'work', name: 'Work', contextId: w.parish.id, projectId: w.retreat.id })

    await w.action('Child item', { projectId: child.id })
    await w.action('Campaign item', { projectId: w.campaign.id })
    await syncTodoist(db)
    expect(fake.byContent('Child item')?.project_id).toBe('work')
    expect(fake.byContent('Campaign item')?.project_id).toBe('inbox')

    await bindTodoistProject(db, { connectionId: connection.id, todoistProjectId: 'parish', name: 'Parish', contextId: w.parish.id })
    await w.action('Plain item')
    await syncTodoist(db)
    expect(fake.byContent('Plain item')?.project_id).toBe('parish')
  })
})

describe('both ways', () => {
  async function synced() {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const item = await w.action('Send the form', { dueOn: '2026-10-20' })
    await syncTodoist(db)
    const taskId = (await link(item.id))!.taskId!
    return { fake, w, item, taskId }
  }

  it('leaves the date alone when the task is rescheduled in Todoist, twice', async () => {
    const { fake, item, taskId } = await synced()
    fake.edit(taskId, { due: { date: '2026-10-25' } })
    await syncTodoist(db)
    fake.edit(taskId, { due: { date: '2026-10-27' } })
    await syncTodoist(db)
    expect((await getItem(db, item.id)).dueOn).toBe('2026-10-20')
    expect(fake.tasks.get(taskId)?.due).toEqual({ date: '2026-10-27' })
  })

  it('carries deadline and text changes each way', async () => {
    const { fake, item, taskId } = await synced()
    await updateItem(db, actor, item.id, { dueOn: '2026-10-22', text: 'Send the new form' })
    await syncTodoist(db)
    expect(fake.tasks.get(taskId)).toMatchObject({ content: 'Send the new form', deadline: { date: '2026-10-22' } })

    fake.edit(taskId, { deadline: { date: '2026-10-30' }, content: 'Send the form today' })
    await syncTodoist(db)
    const after = await getItem(db, item.id)
    expect(after).toMatchObject({ dueOn: '2026-10-30', text: 'Send the form today' })

    // A pass with nothing new changes nothing.
    const commands = fake.commands.length
    await syncTodoist(db)
    expect(fake.commands.length).toBe(commands)
  })

  it('lets Todoist win when both changed', async () => {
    const { fake, item, taskId } = await synced()
    await updateItem(db, actor, item.id, { dueOn: '2026-11-01' })
    fake.edit(taskId, { deadline: { date: '2026-11-05' } })
    await syncTodoist(db)
    expect((await getItem(db, item.id)).dueOn).toBe('2026-11-05')
    expect(fake.tasks.get(taskId)?.deadline).toEqual({ date: '2026-11-05' })
  })

  it('closes an action ticked off in Todoist, and reopens it with the task', async () => {
    const { fake, item, taskId } = await synced()
    fake.edit(taskId, { checked: true })
    await syncTodoist(db)
    expect((await getItem(db, item.id)).status).toBe('done')

    fake.edit(taskId, { checked: false })
    await syncTodoist(db)
    expect((await getItem(db, item.id)).status).toBe('open')
  })

  it('does not reopen after 30 days, and gives a later reopen a new task', async () => {
    const { fake, item, taskId } = await synced()
    await completeItem(db, actor, item.id)
    await syncTodoist(db)
    expect(fake.tasks.get(taskId)?.checked).toBe(true)

    fake.edit(taskId, { checked: false })
    await syncTodoist(db, new Date(Date.now() + 31 * 24 * 3600 * 1000))
    expect((await getItem(db, item.id)).status).toBe('done')
    expect((await link(item.id))?.unlinkedReason).toBe('expired')

    await reopenItem(db, actor, item.id)
    await syncTodoist(db)
    const tasks = [...fake.tasks.values()].filter((task) => task.content === 'Send the form')
    expect(tasks).toHaveLength(2)
  })

  it('moves a question ticked off in Todoist to needs answer, and back', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const question = await createItem(db, actor, { contextId: w.parish.id, kind: 'question', text: 'Which room?', parties: w.mine() })
    await syncTodoist(db)
    const taskId = (await link(question.id))!.taskId!

    fake.edit(taskId, { checked: true })
    await syncTodoist(db)
    expect((await getItem(db, question.id)).status).toBe('needs_answer')

    await answerItem(db, actor, question.id, { answer: 'The hall' })
    await syncTodoist(db)
    expect((await getItem(db, question.id)).status).toBe('done')
    expect(fake.tasks.get(taskId)?.checked).toBe(true)
  })

  it('closes the task on done, dropped, converted, owner removed', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const done = await w.action('Done one')
    const dropped = await w.action('Dropped one')
    const converted = await w.action('Converted one')
    const removed = await w.action('Removed one')
    await syncTodoist(db)

    await completeItem(db, actor, done.id)
    await dropItem(db, actor, dropped.id)
    await convertItem(db, actor, converted.id, 'topic')
    await removeItemParty(db, actor, removed.id, { personId: w.john.id })
    await syncTodoist(db)

    for (const text of ['Done one', 'Dropped one', 'Converted one', 'Removed one']) {
      expect(fake.byContent(text)?.checked, text).toBe(true)
    }
    // Reopened in Todoist, a topic stays a topic and its task is closed again.
    fake.edit(fake.byContent('Converted one')!.id, { checked: false })
    await syncTodoist(db)
    expect((await getItem(db, converted.id)).kind).toBe('topic')
    expect(fake.byContent('Converted one')?.checked).toBe(true)
  })

  it('unlinks quietly when the task is deleted or made recurring, and does not make it again', async () => {
    const { fake, w, item, taskId } = await synced()
    fake.edit(taskId, { is_deleted: true })
    await syncTodoist(db)
    expect((await getItem(db, item.id)).status).toBe('open')
    expect((await link(item.id))?.unlinkedReason).toBe('deleted')
    await syncTodoist(db)
    expect([...fake.tasks.values()].filter((task) => task.content === 'Send the form')).toHaveLength(1)

    const other = await w.action('Weekly report')
    await syncTodoist(db)
    const otherTask = (await link(other.id))!.taskId!
    fake.edit(otherTask, { due: { date: '2026-10-20', is_recurring: true } })
    await syncTodoist(db)
    expect((await link(other.id))?.unlinkedReason).toBe('recurring')
  })

  it('deletes the task of an accept that was undone', async () => {
    const { fake, item, taskId } = await synced()
    await takeBackItem(db, item.id, ['created'])
    await syncTodoist(db)
    expect(fake.tasks.get(taskId)?.is_deleted).toBe(true)
  })

  it('leaves the task alone for a deleted item it already closed', async () => {
    const { fake, item, taskId } = await synced()
    await dropItem(db, actor, item.id)
    await deleteItem(db, actor, item.id)
    await syncTodoist(db)
    expect(fake.tasks.get(taskId)).toMatchObject({ checked: true, is_deleted: false })
  })

  it('pauses with an archived context, and catches up when it is live again', async () => {
    const { fake, w, item, taskId } = await synced()
    await archive(db, 'context', w.parish.id)
    fake.edit(taskId, { content: 'Changed while paused' })
    await syncTodoist(db)
    expect((await getItem(db, item.id)).text).toBe('Send the form')

    await unarchive(db, 'context', w.parish.id)
    await syncTodoist(db)
    expect((await getItem(db, item.id)).text).toBe('Changed while paused')
  })

  it('writes history as Todoist', async () => {
    const { fake, item, taskId } = await synced()
    fake.edit(taskId, { checked: true })
    await syncTodoist(db)
    const events = await db.select().from(itemEvents).where(eq(itemEvents.itemId, item.id))
    expect(events.find((event) => event.type === 'completed')?.source).toBe('todoist')
  })
})

describe('failures', () => {
  it('makes a task once when a pass is retried', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const item = await w.action('Only once')
    // The pass dies after Todoist has made the task, before its id is saved.
    const original = fake.commands.length
    fake.refuse.set('never', 'x')
    await syncTodoist(db)
    const [row] = await db.select().from(itemTodoistLinks).where(eq(itemTodoistLinks.itemId, item.id))
    await db.update(itemTodoistLinks).set({ state: 'pending', taskId: null }).where(eq(itemTodoistLinks.id, row!.id))
    await syncTodoist(db)

    expect(fake.commands.length).toBeGreaterThan(original)
    expect([...fake.tasks.values()].filter((task) => task.content === 'Only once')).toHaveLength(1)
    expect((await link(item.id))?.state).toBe('linked')
  })

  it('keeps a refused change for the next pass', async () => {
    const { fake, item, taskId } = await (async () => {
      const fake = fakeTodoist()
      const w = await world()
      await connect()
      const item = await w.action('Refused')
      await syncTodoist(db)
      return { fake, item, taskId: (await link(item.id))!.taskId! }
    })()
    fake.refuse.set('item_update', 'Nope')
    await updateItem(db, actor, item.id, { text: 'Refused, edited' })
    await syncTodoist(db)
    expect((await link(item.id))?.lastError).toBe('Nope')

    fake.refuse.clear()
    await syncTodoist(db)
    expect(fake.tasks.get(taskId)?.content).toBe('Refused, edited')
    expect((await link(item.id))?.lastError).toBeNull()
  })

  it('makes a refused task again in the Inbox', async () => {
    const fake = fakeTodoist()
    const w = await world()
    const { connection } = await connect()
    await bindTodoistProject(db, { connectionId: connection.id, todoistProjectId: 'gone', name: 'Gone', contextId: w.parish.id })
    fake.refuse.set('item_add', 'Project not found')
    const item = await w.action('Homeless')
    await syncTodoist(db)
    expect((await link(item.id))?.lastError).toBe('Project not found')

    fake.refuse.clear()
    await syncTodoist(db)
    expect(fake.byContent('Homeless')?.project_id).toBe('inbox')
    expect((await link(item.id))?.state).toBe('linked')
  })

  it('records a refused token on the connection', async () => {
    const fake = fakeTodoist()
    await world()
    await connect()
    fake.token = 'revoked'
    await expect(syncTodoist(db)).rejects.toThrow(/no longer accepts/)
    const [row] = await db.select().from(connections)
    expect(row?.lastError).toMatch(/no longer accepts/)
  })
})

describe('matching', () => {
  it('links an item to a task John already has, taking the task’s words', async () => {
    const fake = fakeTodoist()
    const taskId = fake.add('Send agency chairs the meeting dates form', { deadline: { date: '2026-11-02' } })
    fake.add('Buy milk')
    const w = await world()
    const item = await w.action('Send chairs the form for agency meeting dates')
    await connect()

    const ranked = rankTasks(item.text, await openTasks(db))
    expect(ranked[0]?.id).toBe(taskId)

    await linkItem(db, { itemId: item.id, task: `https://app.todoist.com/app/task/send-agency-${taskId}` })
    await syncTodoist(db)
    expect(await getItem(db, item.id)).toMatchObject({
      text: 'Send agency chairs the meeting dates form',
      dueOn: '2026-11-02',
    })
    expect(await itemTodoist(db, item.id)).toMatchObject({ state: 'linked', taskId })
    expect(await unmatchedItemIds(db)).toEqual([])
    // A linked task is offered to no other item.
    expect((await openTasks(db)).map((task) => task.id)).not.toContain(taskId)
    await expect(linkItem(db, { itemId: (await w.action('Another')).id, task: taskId })).rejects.toThrow(/already linked/)
  })

  it('sends one as a new task, and skips another for good', async () => {
    const fake = fakeTodoist()
    const w = await world()
    const sent = await w.action('Send me')
    const skipped = await w.action('Skip me')
    await connect()

    await sendItem(db, sent.id)
    await skipItem(db, skipped.id)
    await syncTodoist(db)
    expect(fake.byContent('Send me')).toBeDefined()
    expect(fake.byContent('Skip me')).toBeUndefined()
    expect(await itemTodoist(db, skipped.id)).toEqual({ state: 'skipped' })
    expect(await unmatchedItemIds(db)).toEqual([])
  })

  it('says nothing for an item that does not sync', async () => {
    fakeTodoist()
    const w = await world()
    await connect()
    const topic = await createItem(db, actor, { contextId: w.parish.id, kind: 'topic', text: 'Topic', parties: w.mine() })
    expect(await itemTodoist(db, topic.id)).toBeNull()
    await expect(sendItem(db, topic.id)).rejects.toThrow(/open action or question/)
  })
})

describe('comments', () => {
  async function synced() {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const item = await w.action('Send the form')
    await syncTodoist(db)
    const taskId = (await link(item.id))!.taskId!
    return { fake, w, item, taskId }
  }

  it('shows a comment on a linked task on its item, edited as it is in Todoist', async () => {
    const { fake, item, taskId } = await synced()
    const id = fake.comment(taskId, 'Chased the printer', '2026-10-18T09:00:00Z')
    await syncTodoist(db)
    expect(await itemComments(db, item.id)).toEqual([
      { id, content: 'Chased the printer', postedAt: new Date('2026-10-18T09:00:00Z') },
    ])

    fake.editComment(id, 'Chased the printer again')
    await syncTodoist(db)
    expect((await itemComments(db, item.id)).map((one) => one.content)).toEqual(['Chased the printer again'])
  })

  it('removes a comment deleted in Todoist', async () => {
    const { fake, item, taskId } = await synced()
    const keep = fake.comment(taskId, 'Keep', '2026-10-18T09:00:00Z')
    const gone = fake.comment(taskId, 'Gone', '2026-10-18T10:00:00Z')
    await syncTodoist(db)
    expect(await itemComments(db, item.id)).toHaveLength(2)

    fake.deleteComment(gone)
    await syncTodoist(db)
    expect((await itemComments(db, item.id)).map((one) => one.id)).toEqual([keep])
  })

  it('ignores a comment on a task no item is linked to', async () => {
    const { fake } = await synced()
    const own = fake.add('Renew the car insurance')
    fake.comment(own, 'Quote in')
    await syncTodoist(db)
    expect(await db.select().from(todoistComments)).toHaveLength(0)
  })

  it('reads a task’s existing comments once it is linked to an item from Match', async () => {
    const fake = fakeTodoist()
    const w = await world()
    const item = await w.action('Renew the car insurance')
    const taskId = fake.add('Renew the car insurance')
    const old = fake.comment(taskId, 'Called the broker', '2026-10-01T09:00:00Z')
    await connect()
    await syncTodoist(db)
    expect(await itemComments(db, item.id)).toHaveLength(0)

    await linkItem(db, { itemId: item.id, task: taskId })
    await syncTodoist(db)
    expect((await itemComments(db, item.id)).map((one) => one.id)).toEqual([old])
    expect(fake.commentReads).toEqual([taskId])

    /* Read once; after that the feed carries them. */
    const next = fake.comment(taskId, 'Quote in')
    await syncTodoist(db)
    expect((await itemComments(db, item.id)).map((one) => one.id)).toEqual([old, next])
    expect(fake.commentReads).toEqual([taskId])
  })

  it('backfills comments older than the feed’s cursor on tasks linked before comments were read', async () => {
    const { fake, item, taskId } = await synced()
    expect(fake.commentReads).toEqual([])
    const old = fake.comment(taskId, 'Daily review: waiting on Tom', '2026-10-10T09:00:00Z')
    // As if linked before this shipped: the cursor is past the comment and the link never read.
    await db.update(connections).set({ cursor: 's999999' })
    await db.update(itemTodoistLinks).set({ commentsReadAt: null }).where(eq(itemTodoistLinks.itemId, item.id))

    await syncTodoist(db)
    expect((await itemComments(db, item.id)).map((one) => one.content)).toEqual(['Daily review: waiting on Tom'])
    expect(fake.commentReads).toEqual([taskId])

    // A whole read also drops what Todoist no longer has.
    fake.deleteComment(old)
    await db.update(itemTodoistLinks).set({ commentsReadAt: null }).where(eq(itemTodoistLinks.itemId, item.id))
    await db.update(connections).set({ cursor: 's999999' })
    await syncTodoist(db)
    expect(await itemComments(db, item.id)).toHaveLength(0)
  })

  it('writes nothing to the item’s own history', async () => {
    const { fake, item, taskId } = await synced()
    const before = await db.select().from(itemEvents).where(eq(itemEvents.itemId, item.id))
    fake.comment(taskId, 'Status: waiting')
    await syncTodoist(db)
    expect(await db.select().from(itemEvents).where(eq(itemEvents.itemId, item.id))).toHaveLength(before.length)
  })
})

describe('the webhook', () => {
  it('asks for a sync on a task or comment event, once per delivery', async () => {
    fakeTodoist()
    await world()
    await connect()
    const one = delivery({ event_name: 'item:completed', event_data: { id: 't1' } }, { id: 'd-1' })
    expect(await receiveTodoistDelivery(db, one)).toMatchObject({ status: 200, sync: true })
    expect(await receiveTodoistDelivery(db, one)).toMatchObject({ status: 200, sync: false, body: { replay: true } })

    const note = delivery({ event_name: 'note:added', event_data: { id: 'n1', item_id: 't1' } })
    expect(await receiveTodoistDelivery(db, note)).toMatchObject({ status: 200, sync: true })

    const project = delivery({ event_name: 'project:added' })
    expect(await receiveTodoistDelivery(db, project)).toMatchObject({ status: 200, sync: false })
    const rows = await db.select().from(integrationEvents).where(and(eq(integrationEvents.provider, 'todoist')))
    expect(rows).toHaveLength(3)
  })

  it('refuses a delivery signed with anything else', async () => {
    fakeTodoist()
    await world()
    await connect()
    const forged = delivery({ event_name: 'item:updated' }, { secret: 'not the secret' })
    expect(await receiveTodoistDelivery(db, forged)).toMatchObject({ status: 401, sync: false })
    expect(await db.select().from(integrationEvents)).toHaveLength(0)
  })

  it('is not there without an app', async () => {
    const result = await receiveTodoistDelivery(db, delivery({ event_name: 'item:updated' }))
    expect(result.status).toBe(404)
  })
})

describe('the connection', () => {
  it('refuses a second account', async () => {
    const fake = fakeTodoist()
    await world()
    await connect()
    expect((await todoistConnection(db))?.account).toBe('john@example.test')
    fake.token = 'someone else'
    const { saveTodoistConnection } = await import('../lib/connect/todoist/connection')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: '2', email: 'other@example.test' })))
    await expect(
      saveTodoistConnection(db, { accessToken: 'x', refreshToken: null, expiresAt: null }),
    ).rejects.toThrow(/Disconnect it first/)
  })

  it('refreshes an expired token, keeping the one Todoist rotates to', async () => {
    const fake = fakeTodoist()
    await world()
    const { saveTodoistConnection, todoistToken } = await import('../lib/connect/todoist/connection')
    const { connection } = await saveTodoistConnection(db, {
      accessToken: fake.token,
      refreshToken: 'refresh-0',
      expiresAt: Date.now() - 1000,
    })
    fake.token = 'todoist_access_token'
    expect(await todoistToken(db, connection.id)).toBe('todoist_access_token')
    const { unsealCredentials } = await import('../lib/connect/connections')
    const [row] = await db.select().from(connections).where(eq(connections.id, connection.id))
    expect(unsealCredentials<{ refreshToken: string }>(row!.credentials)?.refreshToken).toBe('refresh-1')
  })
})

describe('asking', () => {
  it('sends the ask, not the question, and ticking it brings the question back as Waiting on', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const question = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'Closing scripture?',
      parties: [{ personId: w.bishop.id, role: 'owner' }],
    })
    const { ask } = await askItem(db, actor, question.id)
    await syncTodoist(db)

    expect(fake.byContent('Closing scripture?')).toBeUndefined()
    const taskId = (await link(ask.id))!.taskId!
    expect(fake.tasks.get(taskId)?.content).toBe('Ask Bishop Wright: Closing scripture?')

    fake.edit(taskId, { checked: true })
    await syncTodoist(db)
    expect((await getItem(db, ask.id)).status).toBe('done')
    expect((await getItem(db, question.id)).parkedAt).toBeNull()
  })
})

describe('an ongoing question', () => {
  it('is never sent, and becoming ongoing closes the task a question had', async () => {
    const fake = fakeTodoist()
    const w = await world()
    await connect()
    const mine = (text: string, ongoing: boolean) =>
      createItem(db, actor, { contextId: w.parish.id, kind: 'question', text, ongoing, parties: w.mine() })
    await mine('2028 pilgrimage dates?', true)
    const venue = await mine('Which venue?', false)
    await syncTodoist(db)
    expect(fake.byContent('2028 pilgrimage dates?')).toBeUndefined()
    expect(fake.byContent('Which venue?')?.checked).toBe(false)

    await setOngoing(db, actor, venue.id, true)
    await syncTodoist(db)
    expect(fake.byContent('Which venue?')?.checked).toBe(true)
    expect((await getItem(db, venue.id)).status).toBe('open')
  })
})
