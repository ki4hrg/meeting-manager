/* The world the browser tests start from: two contexts, a few people, items
   that are due, a meeting coming up and one with a proposal waiting. Dates are
   relative to today, so home always has something in each section. */

import { randomUUID } from 'node:crypto'
import { createFirstUser } from '../lib/auth/users'
import { addDays, todayIn } from '../lib/core/dates'
import { db } from '../lib/db'
import { createContext } from '../lib/directory/contexts'
import { createPerson, ensureSelf } from '../lib/directory/people'
import { createItem } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { addProposals } from '../lib/processing/proposals'
import { createProject } from '../lib/projects/projects'
import { ACCOUNT, WORLD } from './world'

export async function seed({ todoistToken }: { todoistToken?: string } = {}) {
  const actor = { userId: null, source: 'system' as const, requestId: randomUUID() }
  await createFirstUser({ email: ACCOUNT.email, displayName: ACCOUNT.name, password: ACCOUNT.password }, db)

  const conference = await createContext(db, { name: WORLD.contexts.conference })
  const church = await createContext(db, { name: WORLD.contexts.church })
  const john = await ensureSelf(db, { displayName: ACCOUNT.name, email: ACCOUNT.email })
  const adlene = await createPerson(db, { name: WORLD.people.adlene, email: 'adlene@example.test' })
  const sarah = await createPerson(db, { name: WORLD.people.sarah })

  const standing = await createProject(db, { contextId: conference.id, name: WORLD.projects.standing })
  const year = await createProject(db, { contextId: conference.id, name: WORLD.projects.year, parentId: standing.id })
  await createProject(db, { contextId: conference.id, name: WORLD.projects.worship, parentId: year.id })

  const today = todayIn(process.env.TZ ?? 'America/Chicago')
  const mine = [{ personId: john.id, role: 'owner' as const }]
  await createItem(db, actor, { contextId: conference.id, kind: 'action', text: WORLD.items.overdue, dueOn: addDays(today, -2), parties: mine, projectId: year.id })
  await createItem(db, actor, { contextId: church.id, kind: 'action', text: WORLD.items.lunch, dueOn: addDays(today, 6), parties: mine })
  await createItem(db, actor, { contextId: church.id, kind: 'action', text: WORLD.items.bulletin, dueOn: addDays(today, 3), parties: [{ personId: sarah.id, role: 'owner' }] })
  // Nowhere to go yet: the Church's Inbox, listed there whichever context is selected.
  await createItem(db, actor, { contextId: church.id, kind: 'topic', text: WORLD.items.loose })
  await createItem(db, actor, { contextId: conference.id, kind: 'topic', text: WORLD.items.accountability, parties: [{ personId: adlene.id, role: 'with' }] })
  // Asked by John of no one in particular: it will come as a press release.
  await createItem(db, actor, { contextId: conference.id, kind: 'question', text: WORLD.items.delegateCost, dueOn: addDays(today, 5), parties: [{ personId: john.id, role: 'with' }], projectId: year.id })

  const at = (days: number, hour: number) => {
    const moment = new Date()
    moment.setDate(moment.getDate() + days)
    moment.setHours(hour, 0, 0, 0)
    return moment
  }
  await createMeeting(db, actor, { contextId: conference.id, title: WORLD.meetings.checkIn, startsAt: at(1, 10), endsAt: at(1, 11), personIds: [adlene.id] })
  /* Questions for the bishop, raised at worship planning: one to ask him, one
     to mention when he is there. */
  const bishop = await createPerson(db, { name: WORLD.people.bishop })
  const planning = await createSeries(db, {
    contextId: conference.id,
    name: WORLD.meetings.planning,
    blocks: { followUps: false, sinceLast: true, lookahead: false },
  })
  const lastPlanning = await createMeeting(db, actor, { contextId: conference.id, seriesId: planning.id, title: WORLD.meetings.planning, startsAt: at(-7, 9), endsAt: at(-7, 10), personIds: [sarah.id] })
  await createMeeting(db, actor, { contextId: conference.id, seriesId: planning.id, title: WORLD.meetings.planning, startsAt: at(7, 9), endsAt: at(7, 10), personIds: [sarah.id] })
  await createMeeting(db, actor, { contextId: conference.id, title: WORLD.meetings.bishop, startsAt: at(3, 14), endsAt: at(3, 15), personIds: [bishop.id] })
  for (const text of [WORLD.items.scripture, WORLD.items.longForm]) {
    await createItem(db, actor, { contextId: conference.id, kind: 'question', text, originMeetingId: lastPlanning.id, parties: [{ personId: bishop.id, role: 'owner' }] })
  }
  // Two days back, so on any clock it is an earlier day's, reviewed under Review rather than Today.
  const finance = await createMeeting(db, actor, { contextId: church.id, title: WORLD.meetings.finance, startsAt: at(-2, 18), endsAt: at(-2, 19), personIds: [sarah.id] })
  await addProposals(db, { meetingId: finance.id }, [
    { payload: { type: 'item', kind: 'action', text: WORLD.proposal, parties: [] } },
  ])

  /* Connected last, so the items above are the ones already open: they wait
     in Match. */
  if (todoistToken) {
    const { connectTodoist } = await import('../lib/connect/todoist/sync')
    await connectTodoist(db, { accessToken: todoistToken, refreshToken: null, expiresAt: null })
  }
}
