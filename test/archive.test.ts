import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  archive,
  listDeleted,
  previewDelete,
  purge,
  purgeExpired,
  restoreDeleted,
  softDelete,
  unarchive,
} from '../lib/archive/archive'
import { contexts, itemParties, people } from '../lib/db/schema'
import { getContext, listContexts } from '../lib/directory/contexts'
import { getGroup, listGroups } from '../lib/directory/groups'
import { createPerson, getPerson, listPeople } from '../lib/directory/people'
import { resolveParty, resolveProject } from '../lib/directory/resolve'
import { completeItem, createItem, dropItem, getItem, listItems } from '../lib/items/items'
import { createMeeting, findMeetingByEvent, getMeeting, listMeetings } from '../lib/meetings/meetings'
import { createSeries, getSeries, listSeries, setSeriesPeople } from '../lib/meetings/series'
import { addMilestone, deleteMilestone, getProject, listMilestones, listProjects } from '../lib/projects/projects'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('archive', () => {
  it('takes a row off the lists and name lookups, while its id still reads', async () => {
    const w = await makeWorld()
    await archive(db, 'project', w.retreat.id)
    await archive(db, 'person', w.tom.id)
    await archive(db, 'group', w.staff.id)

    expect((await listProjects(db, w.parish.id)).map((p) => p.id)).not.toContain(w.retreat.id)
    expect((await listProjects(db, w.parish.id, 'archived')).map((p) => p.id)).toEqual([w.retreat.id])
    expect((await listProjects(db, w.parish.id, 'all')).map((p) => p.id)).toContain(w.retreat.id)
    expect((await listPeople(db)).map((p) => p.id)).not.toContain(w.tom.id)
    expect((await listGroups(db, w.parish.id)).map((g) => g.id)).toEqual([])

    await expect(resolveProject(db, w.parish.id, 'Retreat')).rejects.toThrow('No project matches')
    await expect(resolveParty(db, w.parish.id, 'Tom')).rejects.toThrow('No person or group')
    expect((await resolveParty(db, w.parish.id, w.tom.id)).name).toBe('Tom Baker')

    expect((await getProject(db, w.retreat.id)).archivedAt).toBeInstanceOf(Date)
    expect((await getPerson(db, w.tom.id)).archivedAt).toBeInstanceOf(Date)
    expect((await getGroup(db, w.staff.id)).name).toBe('Staff')

    await unarchive(db, 'project', w.retreat.id)
    expect((await resolveProject(db, w.parish.id, 'Retreat')).id).toBe(w.retreat.id)
  })

  it('refuses John himself and the last live context', async () => {
    const w = await makeWorld()
    await expect(archive(db, 'person', w.john.id)).rejects.toThrow('yourself')
    await archive(db, 'context', w.diocese.id)
    await expect(archive(db, 'context', w.parish.id)).rejects.toThrow('only context')
    expect((await listContexts(db)).map((c) => c.id)).toEqual([w.parish.id])
  })

  it('puts a meeting away: off the lists, and its event stays held', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Lunch',
      startsAt: new Date('2030-01-01T17:00:00Z'),
      calendarEventId: 'evt_lunch',
    })
    await archive(db, 'meeting', meeting.id)
    expect(await listMeetings(db, { contextId: w.parish.id })).toEqual([])
    expect((await listMeetings(db, { contextId: w.parish.id, shelf: 'archived' })).map((m) => m.id)).toEqual([meeting.id])
    expect((await findMeetingByEvent(db, 'evt_lunch'))?.id).toBe(meeting.id)
  })
})

describe('delete', () => {
  it('is offered only on an archived row, and refuses while something depends on it, naming it', async () => {
    const w = await makeWorld()
    const weekly = await createSeries(db, { contextId: w.parish.id, name: 'Staff weekly' })
    await setSeriesPeople(db, weekly.id, [w.sarah.id])
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'Call the bishop',
      parties: [{ personId: w.sarah.id, role: 'owner' }],
    })

    await expect(softDelete(db, 'person', w.sarah.id)).rejects.toThrow('Archive it first')
    await archive(db, 'person', w.sarah.id)
    const preview = await previewDelete(db, 'person', w.sarah.id)
    expect(preview.blockers).toEqual(['On 1 open item', 'On the Staff weekly roster'])
    await expect(softDelete(db, 'person', w.sarah.id)).rejects.toThrow('On 1 open item')

    await dropItem(db, actor, item.id)
    await setSeriesPeople(db, weekly.id, [])
    expect(await previewDelete(db, 'person', w.sarah.id)).toEqual({
      blockers: [],
      takes: ['Their name on 1 closed item'],
    })
    await softDelete(db, 'person', w.sarah.id)
    await expect(getPerson(db, w.sarah.id)).rejects.toThrow()
    // What pointed at her still reads her name until she is gone for good.
    expect((await getItem(db, item.id)).parties.map((p) => p.name)).toEqual(['Sarah Jones'])
  })

  it('refuses a project with meetings, sub-projects or open items', async () => {
    const w = await makeWorld()
    await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat planning', projectIds: [w.retreat.id] })
    await createItem(db, actor, { contextId: w.parish.id, text: 'Book the hall', projectId: w.retreat.id })
    await archive(db, 'project', w.retreat.id)
    const { blockers } = await previewDelete(db, 'project', w.retreat.id)
    expect(blockers).toEqual(['On 1 meeting', '1 open item'])
  })

  it('refuses a meeting that items came out of, and lets its event go when it can', async () => {
    const w = await makeWorld()
    const kept = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Board' })
    await createItem(db, actor, { contextId: w.parish.id, text: 'From the board', originMeetingId: kept.id })
    await archive(db, 'meeting', kept.id)
    await expect(softDelete(db, 'meeting', kept.id)).rejects.toThrow('1 item came out of it')

    const stray = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Lunch',
      startsAt: new Date('2030-01-01T17:00:00Z'),
      calendarEventId: 'evt_lunch',
    })
    await archive(db, 'meeting', stray.id)
    await softDelete(db, 'meeting', stray.id)
    await expect(getMeeting(db, stray.id)).rejects.toThrow()
    expect(await findMeetingByEvent(db, 'evt_lunch')).toBeNull()
  })

  it('lists what was deleted, restores it, and removes it for good after 30 days', async () => {
    const w = await makeWorld()
    const item = await createItem(db, actor, { contextId: w.parish.id, text: 'test', kind: 'action' })
    await completeItem(db, actor, item.id)
    const { deleteItem } = await import('../lib/items/items')
    await deleteItem(db, actor, item.id)
    const milestone = await addMilestone(db, { projectId: w.retreat.id, title: 'Go-live', dueOn: '2030-01-01' })
    await deleteMilestone(db, milestone.id)
    await archive(db, 'series', (await createSeries(db, { contextId: w.parish.id, name: 'Old' })).id)
    const old = (await listSeries(db, w.parish.id, 'archived'))[0]!
    await softDelete(db, 'series', old.id)

    const deleted = await listDeleted(db)
    expect(deleted.map((row) => [row.kind, row.name, row.context])).toEqual(
      expect.arrayContaining([
        ['item', 'test', 'Parish'],
        ['milestone', 'Go-live', 'Parish'],
        ['series', 'Old', 'Parish'],
      ]),
    )

    await restoreDeleted(db, 'milestone', milestone.id)
    expect((await listMilestones(db, w.retreat.id)).map((m) => m.id)).toEqual([milestone.id])
    await restoreDeleted(db, 'series', old.id)
    expect((await getSeries(db, old.id)).archivedAt).toBeInstanceOf(Date)

    // Not yet: 29 days on, nothing goes.
    const day = 86_400_000
    expect(await purgeExpired(db, new Date(Date.now() + 29 * day))).toBe(0)
    expect(await purgeExpired(db, new Date(Date.now() + 31 * day))).toBe(1)
    expect(await listItems(db, { contextId: w.parish.id })).toEqual([])
    expect(await listDeleted(db)).toEqual([])
  })

  it('removes a person for good, taking their name off closed items', async () => {
    const w = await makeWorld()
    const extra = await createPerson(db, { name: 'Temp Person', email: 'temp@example.test' })
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'Old thing',
      kind: 'action',
      parties: [{ personId: extra.id, role: 'owner' }],
    })
    await completeItem(db, actor, item.id)
    await archive(db, 'person', extra.id)
    await softDelete(db, 'person', extra.id)
    await purge(db, 'person', extra.id)
    expect(await db.select().from(people).where(eq(people.id, extra.id))).toEqual([])
    expect(await db.select().from(itemParties).where(eq(itemParties.itemId, item.id))).toEqual([])
    // The address is free again.
    await createPerson(db, { name: 'Someone new', email: 'temp@example.test' })
  })

  it('a context goes whole: everything in it, for good', async () => {
    const w = await makeWorld()
    await createItem(db, actor, { contextId: w.diocese.id, text: 'Synod agenda', projectId: w.synod.id })
    await createMeeting(db, actor, { contextId: w.diocese.id, title: 'Council', groupId: w.council.id })
    await archive(db, 'context', w.diocese.id)
    const { takes } = await previewDelete(db, 'context', w.diocese.id)
    expect(takes).toEqual(['1 item', '1 meeting', '1 project', '1 group'])
    await softDelete(db, 'context', w.diocese.id)
    await expect(getContext(db, w.diocese.id)).rejects.toThrow()
    await purge(db, 'context', w.diocese.id)
    expect((await db.select().from(contexts)).map((c) => c.id)).toEqual([w.parish.id])
  })
})
