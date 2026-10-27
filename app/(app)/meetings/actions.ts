'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { placeItem, restoreCandidate } from '@/lib/agenda/candidates'
import { setRecapEdits } from '@/lib/agenda/recap'
import {
  addLine,
  addSection,
  importOutline,
  moveToSession,
  nudgeLine,
  removeLine,
  restoreLine,
  updateLine,
} from '@/lib/agenda/lines'
import { requireUser } from '@/lib/auth/guards'
import { formatTime, fromLocalInput, isDay } from '@/lib/core/dates'
import { ValidationError, inTransaction } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listContexts } from '@/lib/directory/contexts'
import type { BlockSettings } from '@/lib/db/schema'
import { markAsked, markDiscussed } from '@/lib/items/items'
import {
  getMeeting,
  setMeetingPeople,
  setMeetingProjects,
  updateMeeting,
} from '@/lib/meetings/meetings'
import { moveMeeting } from '@/lib/meetings/move'
import {
  attachStub,
  findEvent,
  findOccurrences,
  prepFromEvent,
  prepMeeting,
  prepWithGroup,
  prepWithPerson,
  seriesFromEvent,
  unpreppedOn,
} from '@/lib/meetings/prep'
import { takeRoll } from '@/lib/meetings/attendance'
import { addToRoster } from '@/lib/meetings/series'
import { act, field, pickedParties, pickedPeople, type ActionResult } from '@/lib/web/action'
import { clearAbsences, joinRoster, recordAbsences } from '@/lib/meetings/roster'
import { CONTEXT_COOKIE, contextCookieOptions, currentContext } from '@/lib/web/context'

async function contextId(): Promise<string> {
  const context = await currentContext()
  if (!context) throw new ValidationError('Create a context first.')
  return context.id
}

/* An event card on home names its own context, which may not be the selected
   one; anywhere else the card acts in the selected context. */
async function eventContext(formData: FormData): Promise<string> {
  const named = field(formData, 'contextId')
  if (!named) return contextId()
  if (!(await listContexts(db)).some((context) => context.id === named)) {
    throw new ValidationError('That context is archived.')
  }
  return named
}

/* Opening a meeting made in another context selects that context first. */
async function selectFrom(formData: FormData): Promise<void> {
  const named = field(formData, 'contextId')
  if (named) (await cookies()).set(CONTEXT_COOKIE, named, contextCookieOptions)
}

/* Every action that makes or finds a meeting ends on its page. */
async function thenOpen(
  work: Parameters<typeof act>[0],
  meetingId: () => string,
): Promise<ActionResult> {
  const result = await act(work)
  if (!result.error) redirect(`/meetings/${meetingId()}`)
  return result
}

const ids = (formData: FormData, name: string) =>
  formData.getAll(name).map(String).filter(Boolean)

/* When an event card said its event starts, so it is looked for there. */
function aroundFrom(formData: FormData): Date | undefined {
  const at = field(formData, 'at')
  return at ? new Date(at) : undefined
}

/* A whole number of minutes from a form field, or null when it is empty. */
function minutesFrom(value: string): number | null {
  if (value === '') return null
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes < 0) throw new ValidationError('Minutes are a whole number.')
  return minutes
}

/* When a meeting form says it starts and ends, in the user's zone. No start is
   an undated stub, and a stub has no end. */
function timesFrom(formData: FormData, timeZone: string | null) {
  const value = field(formData, 'startsAt')
  if (value === '') return { startsAt: null, endsAt: null }
  const end = field(formData, 'endsAt')
  return {
    startsAt: fromLocalInput(value, timeZone),
    endsAt: end === '' ? null : fromLocalInput(end, timeZone),
  }
}

// ─── meetings ────────────────────────────────────────────────────────────────

export async function createMeetingAction(formData: FormData): Promise<ActionResult> {
  let id = ''
  return thenOpen(
    async (actor, user) => {
      const context = await contextId()
      const { people, groups } = await pickedParties(db, formData, 'personIds', context)
      const projects = ids(formData, 'projectIds')
      const meeting = await prepMeeting(db, actor, {
        contextId: context,
        title: field(formData, 'title') || null,
        ...timesFrom(formData, user.timeZone),
        seriesId: field(formData, 'seriesId') || undefined,
        /* Nobody picked leaves the roster and groups to the series. */
        ...(groups.length > 0 ? { groupIds: groups } : {}),
        ...(people.length > 0 ? { personIds: people } : {}),
        ...(projects.length > 0 ? { projectIds: projects } : {}),
      })
      id = meeting.id
    },
    () => id,
  )
}

/** A sitting of a multi-day meeting: it starts with its parent's people, group and projects. */
export async function addSessionAction(formData: FormData): Promise<ActionResult> {
  let id = ''
  return thenOpen(
    async (actor, user) => {
      const parent = await getMeeting(db, field(formData, 'parentMeetingId'))
      const title = field(formData, 'title')
      if (title === '') throw new ValidationError('Enter a title.')
      const session = await prepMeeting(db, actor, {
        contextId: parent.contextId,
        parentMeetingId: parent.id,
        title,
        ...timesFrom(formData, user.timeZone),
        groupIds: parent.groups.map((group) => group.id),
        personIds: parent.people.map((person) => person.id),
        projectIds: parent.projects.map((project) => project.id),
      })
      id = session.id
    },
    () => id,
  )
}

export async function updateMeetingAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor, user) => {
    const id = field(formData, 'id')
    await inTransaction(db, async (tx) => {
      const before = await getMeeting(tx, id)
      const seriesId = field(formData, 'seriesId') || null
      const { people, groups } = await pickedParties(tx, formData, 'personIds', before.contextId)
      await updateMeeting(tx, actor, id, {
        title: field(formData, 'title'),
        ...timesFrom(formData, user.timeZone),
        seriesId,
        groupIds: groups,
      })
      await setMeetingPeople(tx, actor, id, people)
      await setMeetingProjects(tx, actor, id, ids(formData, 'projectIds'))
      // Who was added here joins the series' roster too, when asked.
      if (seriesId && seriesId === (before.series?.id ?? null) && formData.has('toSeries')) {
        await addToRoster(tx, seriesId, people, groups)
      }
      /* Within its series, whoever on the roster was taken off is left off
         this meeting alone. Newly in a series, it takes the roster. */
      if (seriesId && seriesId === (before.series?.id ?? null)) {
        await recordAbsences(tx, id)
      } else {
        await clearAbsences(tx, [id])
        if (seriesId) await joinRoster(tx, actor, id)
      }
    })
  })
}

/* Select the context a meeting lives in, then open it there. */
async function openIn(contextId: string, meetingId: string): Promise<never> {
  ;(await cookies()).set(CONTEXT_COOKIE, contextId, contextCookieOptions)
  redirect(`/meetings/${meetingId}`)
}

/** Move a meeting to another context and follow it there. */
export async function moveMeetingAction(formData: FormData): Promise<ActionResult> {
  const id = field(formData, 'id')
  let contextId = ''
  const result = await act(async (actor) => {
    const to = field(formData, 'contextId')
    if (to === '') throw new ValidationError('Pick a context.')
    contextId = (await moveMeeting(db, actor, id, to)).contextId
  })
  if (result.error) return result
  return openIn(contextId, id)
}

/** A meeting opened while another context is selected: switch to its own. */
export async function openMeetingAction(formData: FormData): Promise<ActionResult> {
  const id = field(formData, 'id')
  let contextId = ''
  const result = await act(async () => {
    contextId = (await getMeeting(db, id)).contextId
  })
  if (result.error) return result
  return openIn(contextId, id)
}

/** Switch one generated block on or off for this meeting, whatever its series says. */
export async function toggleBlockAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const block = field(formData, 'block') as keyof BlockSettings
    const meeting = await getMeeting(db, field(formData, 'id'))
    if (!['followUps', 'sinceLast', 'lookahead', 'wholeProject'].includes(block)) {
      throw new ValidationError('Unknown block.')
    }
    await updateMeeting(db, actor, meeting.id, {
      blocks: { ...meeting.blocks, [block]: !meeting.blocks[block] },
    })
  })
}

// ─── prep ────────────────────────────────────────────────────────────────────

export async function prepWithPersonAction(formData: FormData): Promise<ActionResult> {
  let id = ''
  return thenOpen(
    async (actor) => {
      const stub = await prepWithPerson(db, actor, {
        contextId: await contextId(),
        personId: field(formData, 'personId'),
      })
      id = stub.id
    },
    () => id,
  )
}

export async function prepWithGroupAction(formData: FormData): Promise<ActionResult> {
  let id = ''
  return thenOpen(
    async (actor) => {
      const stub = await prepWithGroup(db, actor, {
        contextId: await contextId(),
        groupId: field(formData, 'groupId'),
      })
      id = stub.id
    },
    () => id,
  )
}

/** Prep a calendar event: the meeting it already has, or a new one. */
export async function prepEventAction(formData: FormData): Promise<ActionResult> {
  let id = ''
  return thenOpen(
    async (actor) => {
      const context = await eventContext(formData)
      const event = await findEvent(db, context, field(formData, 'eventId'), undefined, undefined, aroundFrom(formData))
      id = (await prepFromEvent(db, actor, { contextId: context, event })).id
      await selectFrom(formData)
    },
    () => id,
  )
}

export type DayEvent = { eventId: string; title: string; at: string; time: string }

/** The selected context's calendar events on a day with no meeting yet, for the New meeting form. */
export async function eventsOnDayAction(day: string): Promise<DayEvent[]> {
  const user = await requireUser()
  const context = await currentContext()
  if (!context || !isDay(day)) return []
  try {
    return (await unpreppedOn(db, context.id, day, user.timeZone)).map((event) => ({
      eventId: event.eventId,
      title: event.title,
      at: event.startsAt.toISOString(),
      time: formatTime(event.startsAt, user.timeZone),
    }))
  } catch {
    // The calendar could not be read: the form still makes a meeting by hand.
    return []
  }
}

/** Give a stub its date from a calendar event, instead of making a second meeting. */
export async function attachStubAction(formData: FormData): Promise<ActionResult> {
  const id = field(formData, 'meetingId')
  return thenOpen(
    async (actor) => {
      const event = await findEvent(db, await eventContext(formData), field(formData, 'eventId'), undefined, undefined, aroundFrom(formData))
      await attachStub(db, actor, id, event)
      await selectFrom(formData)
    },
    () => id,
  )
}

export async function seriesFromEventAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const context = await eventContext(formData)
    const event = await findEvent(db, context, field(formData, 'eventId'))
    // Occurrences already prepped join the series, and the feed says which they are.
    const occurrences = event.seriesId ? await findOccurrences(db, context, event.seriesId) : []
    await seriesFromEvent(db, { contextId: context, event, occurrences })
  })
}

// ─── agenda ──────────────────────────────────────────────────────────────────

export async function addLineAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await addLine(db, actor, field(formData, 'meetingId'), {
      text: field(formData, 'text'),
      sectionId: field(formData, 'sectionId') || null,
    })
  })
}

export async function addSectionAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await addSection(db, actor, field(formData, 'meetingId'), { title: field(formData, 'title') })
  })
}

export async function updateLineAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const id = field(formData, 'id')
    // Sent only from a session: another session of the same meeting takes it.
    const sessionId = formData.has('sessionId') ? field(formData, 'sessionId') : ''
    await inTransaction(db, async (tx) => {
      await updateLine(tx, actor, id, {
        text: field(formData, 'text'),
        // A section has no description, leader or private note, and its form sends none.
        ...(formData.has('description') ? { description: field(formData, 'description') } : {}),
        ...(formData.has('leaderPersonId') ? { leaderPersonId: field(formData, 'leaderPersonId') || null } : {}),
        ...(formData.has('privateNote') ? { privateNote: field(formData, 'privateNote') } : {}),
        ...(formData.has('minutes') ? { minutes: minutesFrom(field(formData, 'minutes')) } : {}),
        // Starts at counts only while the row is pinned.
        pinnedStart: formData.has('pinned') ? field(formData, 'pinnedStart') || null : null,
      })
      if (sessionId) await moveToSession(tx, actor, id, sessionId)
    })
  })
}

export async function nudgeLineAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const direction = field(formData, 'direction')
    if (direction !== 'up' && direction !== 'down') throw new ValidationError('Unknown move.')
    await nudgeLine(db, actor, field(formData, 'id'), direction)
  })
}

export async function removeLineAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => ({ undoId: await removeLine(db, actor, field(formData, 'id')) }))
}

export async function restoreLineAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await restoreLine(db, actor, field(formData, 'undoId'))
  })
}

export async function importOutlineAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    // Not `field()`: an outline's indentation is its structure.
    const text = String(formData.get('text') ?? '')
    await importOutline(db, actor, field(formData, 'meetingId'), text, {
      replace: formData.get('replace') === 'on',
    })
  })
}

export async function markDiscussedAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await inTransaction(db, async (tx) => {
      await markDiscussed(tx, actor, field(formData, 'itemId'), field(formData, 'meetingId'))
      await markAsked(tx, actor, field(formData, 'itemId'), field(formData, 'meetingId'))
    })
  })
}

// ─── candidates ──────────────────────────────────────────────────────────────

export async function placeItemAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await placeItem(db, actor, field(formData, 'meetingId'), field(formData, 'itemId'))
  })
}

/** A whole group of suggestions at once. */
export async function placeItemsAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const meetingId = field(formData, 'meetingId')
    await inTransaction(db, async (tx) => {
      for (const itemId of field(formData, 'itemIds').split(',').filter(Boolean)) {
        await placeItem(tx, actor, meetingId, itemId)
      }
    })
  })
}

export async function restoreCandidateAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await restoreCandidate(db, actor, field(formData, 'meetingId'), field(formData, 'itemId'))
  })
}

/* The roll call: who was here, who was out, who is not yet said, and whoever else came. */
export async function takeRollAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await inTransaction(db, async (tx) => {
      const meeting = await getMeeting(tx, field(formData, 'meetingId'))
      const marked = (name: string) => formData.getAll(name).map(String).filter(Boolean)
      const added = await pickedPeople(tx, formData, 'personIds')
      await takeRoll(tx, meeting.id, {
        here: [...marked('here'), ...added],
        out: marked('out'),
        unsure: marked('unsure'),
        remove: marked('remove'),
      })
    })
  })
}

// ─── recap ───────────────────────────────────────────────────────────────────

/* The recap's edit form: the summary, and each line it says something under.
   Only what was changed from what the form opened with is kept as an edit, so
   a later run still reaches the parts John left alone. */
export async function editRecapAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const meeting = await getMeeting(db, field(formData, 'id'))
    const changed = (name: string) => {
      const value = String(formData.get(name) ?? '').trim()
      return value === String(formData.get(`${name}Was`) ?? '').trim() ? undefined : value
    }
    const lines: Record<string, string> = {}
    for (const lineId of ids(formData, 'lineId')) {
      const value = changed(`line:${lineId}`)
      if (value !== undefined) lines[lineId] = value
    }
    await setRecapEdits(db, actor, meeting.id, { summary: changed('summary'), lines })
  })
}

/** Back to the recap the runs wrote. */
export async function resetRecapAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const meeting = await getMeeting(db, field(formData, 'id'))
    await setRecapEdits(db, actor, meeting.id, null)
  })
}
