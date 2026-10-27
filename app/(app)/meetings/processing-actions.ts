'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { fromLocalInput, parseDay } from '@/lib/core/dates'
import { normalise } from '@/lib/core/match'
import { AppError, ValidationError } from '@/lib/core/types'
import { db } from '@/lib/db'
import type { ProposalPayload, ProposedParty } from '@/lib/db/schema'
import { dismissHeldNote, fileHeldNote, undismissHeldNote } from '@/lib/connect/granola/unfiled'
import { createNamed } from '@/lib/directory/create'
import { resolveParty, resolvePerson } from '@/lib/directory/resolve'
import { ITEM_KINDS } from '@/lib/items/items'
import { PROCESS_NOTES, kick } from '@/lib/jobs'
import { logMeeting } from '@/lib/meetings/log'
import { getMeeting } from '@/lib/meetings/meetings'
import { findEvent, sessionFromNote } from '@/lib/meetings/prep'
import { attendeeIsGroup, dismissAttendee, nameAttendee } from '@/lib/notes/attendees'
import { getNote, meetingOf, moveNote, saveNote } from '@/lib/notes/notes'
import { PROJECT_STATUSES, type ProjectStatus } from '@/lib/projects/projects'
import {
  acceptAsProject,
  acceptEdited,
  acceptProposal,
  approveAll,
  editProposal,
  getProposal,
  rejectProposal,
  undoProposal,
  type ProposalView,
} from '@/lib/processing/proposals'
import { queueRun, reprocessMeeting } from '@/lib/processing/run'
import { act, field, pickedParties, type ActionResult } from '@/lib/web/action'
import { CONTEXT_COOKIE, contextCookieOptions, currentContext } from '@/lib/web/context'

/*
 * Server actions for logging a meeting, the review screen and its notes.
 *
 * Each is a public endpoint, and every id it is handed is checked against the
 * selected context before anything is done with it: a proposal, a note or a
 * meeting from another context is refused, never acted on.
 */

async function contextId(): Promise<string> {
  const context = await currentContext()
  if (!context) throw new ValidationError('Create a context first.')
  return context.id
}

const ELSEWHERE = 'That belongs to another context.'

async function ownMeeting(meetingId: string) {
  const meeting = await getMeeting(db, meetingId)
  if (meeting.contextId !== (await contextId())) throw new ValidationError(ELSEWHERE)
  return meeting
}

async function ownProposal(id: string): Promise<ProposalView> {
  const proposal = await getProposal(db, id)
  await ownMeeting(proposal.meetingId)
  return proposal
}

/* The job is asked to run once the response has gone: processing never holds
   up the screen that queued it. The job's timer is the net under a lost kick. */
function processSoon() {
  after(async () => {
    await kick(PROCESS_NOTES)
  })
}

const values = (formData: FormData, name: string) =>
  formData.getAll(name).map(String).filter(Boolean)

/* What was typed in a picker and never chosen from its suggestions. */
const typed = (formData: FormData, name: string) =>
  field(formData, name)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

/* A lookup that may find nobody: the name then stays a name, to be asked for. */
async function quietly<T>(lookup: Promise<T>): Promise<T | null> {
  try {
    return await lookup
  } catch (error) {
    if (error instanceof AppError) return null
    throw error
  }
}

// ─── log a meeting ───────────────────────────────────────────────────────────

/** People and pasted notes become a meeting, its note and a queued run; then on to its review. */
export async function logMeetingAction(formData: FormData): Promise<ActionResult> {
  let id = ''
  const result = await act(async (actor, user) => {
    const picked = values(formData, 'people')
    const personIds = picked.filter((value) => !value.startsWith('group:'))
    const groupIds = picked.filter((value) => value.startsWith('group:')).map((value) => value.slice(6))
    // A name typed and not picked resolves as it does everywhere, or is refused by name.
    for (const name of typed(formData, 'peopleText')) {
      personIds.push((await resolvePerson(db, name)).id)
    }

    const starts = field(formData, 'startsAt')
    const ends = field(formData, 'endsAt')

    const { meeting } = await logMeeting(db, actor, {
      contextId: await contextId(),
      title: field(formData, 'title') || undefined,
      startsAt: starts === '' ? null : fromLocalInput(starts, user.timeZone),
      endsAt: starts === '' || ends === '' ? null : fromLocalInput(ends, user.timeZone),
      personIds: [...new Set(personIds)],
      groupIds,
      projectIds: values(formData, 'projectIds'),
      // Not `field()`: a note's indentation and blank lines are its own.
      notes: String(formData.get('notes') ?? ''),
    })
    id = meeting.id
    processSoon()
  })
  if (!result.error) redirect(`/meetings/${id}/review`)
  return result
}

// ─── notes and runs ──────────────────────────────────────────────────────────

/** Another note pasted onto a meeting that already exists. */
export async function addNoteAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const meeting = await ownMeeting(field(formData, 'meetingId'))
    const { note } = await saveNote(db, actor, {
      meetingId: meeting.id,
      source: 'pasted',
      body: String(formData.get('body') ?? ''),
    })
    await queueRun(db, note.id)
    processSoon()
  })
}

/** Every note of the meeting again: after a failure, or after the people were corrected. */
export async function reprocessAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const meeting = await ownMeeting(field(formData, 'meetingId'))
    await reprocessMeeting(db, actor, meeting.id)
    processSoon()
  })
}

/** File a note on a session of its meeting, or back on the meeting itself. */
export async function moveNoteAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const note = await getNote(db, field(formData, 'noteId'))
    await ownMeeting(meetingOf(note))
    const to = await ownMeeting(field(formData, 'meetingId'))
    await moveNote(db, actor, note.id, to.id)
  })
}

/** A note on a meeting becomes a session of it, the note filed there. */
export async function sessionFromNoteAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const note = await getNote(db, field(formData, 'noteId'))
    await ownMeeting(meetingOf(note))
    await sessionFromNote(db, actor, note.id)
  })
}

// ─── the Inbox ───────────────────────────────────────────────────────────────

/*
 * A held note belongs to no context, so these two take any note that is still
 * unfiled; one already filed is refused by the domain functions. Filing goes
 * where the form says, the selected context unless another is picked, and
 * then follows the note to its review there.
 */

const EVENT = 'event:'

/* A calendar event picked for a note, looked for around when the note was recorded. */
async function noteEvent(noteId: string, contextId: string, eventId: string) {
  const startsAt = (await getNote(db, noteId)).filing?.startsAt
  return findEvent(db, contextId, eventId, undefined, undefined, startsAt ? new Date(startsAt) : undefined)
}

export async function fileNoteAction(formData: FormData): Promise<ActionResult> {
  let to = { contextId: '', meetingId: '' }
  const result = await act(async (actor) => {
    const chosen = field(formData, 'contextId') || (await contextId())
    const noteId = field(formData, 'noteId')
    /* Link sends the meeting John picked, or a calendar event as `event:<id>`;
       File leaves it to the match. */
    const picked = field(formData, 'meetingId')
    const eventId = picked.startsWith(EVENT) ? picked.slice(EVENT.length) : null
    const { meetingId } = await fileHeldNote(db, actor, noteId, chosen, {
      meetingId: !eventId && picked ? picked : undefined,
      event: eventId ? await noteEvent(noteId, chosen, eventId) : undefined,
    })
    to = { contextId: chosen, meetingId }
    processSoon()
  })
  if (result.error) return result
  ;(await cookies()).set(CONTEXT_COOKIE, to.contextId, contextCookieOptions)
  redirect(`/meetings/${to.meetingId}/review`)
}

export async function dismissNoteAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await dismissHeldNote(db, actor, field(formData, 'noteId'))
  })
}

export async function undismissNoteAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await undismissHeldNote(db, actor, field(formData, 'noteId'))
  })
}

// ─── proposals ───────────────────────────────────────────────────────────────

export async function acceptProposalAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    await acceptProposal(db, actor, proposal.id)
  })
}

export async function rejectProposalAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    await rejectProposal(db, actor, proposal.id)
  })
}

export async function undoProposalAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    await undoProposal(db, actor, proposal.id)
  })
}

export type ApproveAllResult = ActionResult & {
  accepted?: number
  left?: number
  /** Why each one that was tried and refused stayed pending. */
  refused?: string[]
}

/** Everything that needs no thought. What it left is reported, not hidden. */
export async function approveAllAction(formData: FormData): Promise<ApproveAllResult> {
  let outcome: Omit<ApproveAllResult, 'error'> = {}
  const result = await act(async (actor) => {
    const meeting = await ownMeeting(field(formData, 'meetingId'))
    const { accepted, left, refused } = await approveAll(db, actor, meeting.id)
    outcome = { accepted, left, refused: refused.map((one) => one.message) }
  })
  return result.error ? result : outcome
}

/*
 * The parties a picker submits under `name`: `person:<id>`, `group:<id>`,
 * `name:<text>` for one that is still only a name, or `new-person:<name>` /
 * `new-group:<name>` (`new:` is the older spelling of a person) for one to add
 * to the directory now, refused when the name is taken. Whatever was typed and not
 * picked is looked up; a name that finds nobody (or several) stays a name, and
 * the card asks who it is.
 */
async function partiesFrom(
  formData: FormData,
  name: string,
  role: ProposedParty['role'],
  context: string,
): Promise<ProposedParty[]> {
  const parties: ProposedParty[] = []
  for (const value of values(formData, name)) {
    const at = value.indexOf(':')
    const type = value.slice(0, at)
    const rest = value.slice(at + 1)
    if (type === 'person') parties.push({ role, name: '', personId: rest })
    else if (type === 'group') parties.push({ role, name: '', groupId: rest })
    else if (type === 'name' && rest.trim()) parties.push({ role, name: rest.trim() })
    else if ((type === 'new' || type === 'new-person') && rest.trim()) {
      const person = await createNamed(db, context, 'person', rest)
      parties.push({ role, name: person.name, personId: person.id })
    } else if (type === 'new-group' && rest.trim()) {
      const group = await createNamed(db, context, 'group', rest)
      parties.push({ role, name: group.name, groupId: group.id })
    }
    else throw new ValidationError('Pick a person or a group.')
  }
  for (const text of typed(formData, `${name}Text`)) {
    const found = await quietly(resolveParty(db, context, text))
    if (!found) parties.push({ role, name: text })
    else if (found.type === 'person') parties.push({ role, name: found.name, personId: found.id })
    else parties.push({ role, name: found.name, groupId: found.id })
  }
  return parties
}

/**
 * The edit form over a pending proposal's payload: saving it accepts it as
 * edited. What the form does not show is kept.
 */
export async function editProposalAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    const context = await contextId()
    const was = proposal.payload
    let payload: ProposalPayload

    if (was.type === 'item' && field(formData, 'kind') === 'project') {
      // A project of its own: the people count only for the topic kept on it.
      const status = field(formData, 'status') as ProjectStatus
      if (!PROJECT_STATUSES.includes(status)) throw new ValidationError('Pick a status.')
      const keepTopic = formData.has('keepTopic')
      await acceptAsProject(
        db,
        actor,
        proposal.id,
        {
          ...was,
          text: field(formData, 'text'),
          detail: field(formData, 'detail') || null,
          parties: keepTopic
            ? [
                ...(await partiesFrom(formData, 'owners', 'owner', context)),
                ...(await partiesFrom(formData, 'withs', 'with', context)),
              ]
            : was.parties,
        },
        { name: field(formData, 'text'), parentId: field(formData, 'projectId') || null, status, keepTopic },
      )
      return
    }

    if (was.type === 'item') {
      const kind = ITEM_KINDS.find((known) => known === field(formData, 'kind'))
      if (!kind) throw new ValidationError('Pick a kind.')
      payload = {
        ...was,
        kind,
        text: field(formData, 'text'),
        detail: field(formData, 'detail') || null,
        resolution: field(formData, 'resolution') || null,
        parties: [
          ...(await partiesFrom(formData, 'owners', 'owner', context)),
          ...(await partiesFrom(formData, 'withs', 'with', context)),
        ],
        projectId: field(formData, 'projectId') || null,
        dueOn: parseDay(field(formData, 'dueOn')),
        seriesId: field(formData, 'seriesId') || null,
        ongoing: kind === 'question' && formData.get('ongoing') === 'on',
      }
    } else if (was.type === 'update') {
      payload = {
        ...was,
        change: field(formData, 'change') as typeof was.change,
        text: field(formData, 'text') || null,
      }
    } else if (was.type === 'document') {
      payload = {
        ...was,
        title: field(formData, 'title'),
        body: String(formData.get('body') ?? ''),
        projectId: field(formData, 'projectId') || null,
      }
    } else {
      const people = (await partiesFrom(formData, 'people', 'with', context)).map((party) => {
        if (party.groupId) throw new ValidationError('A meeting is with people, not a group.')
        return party.personId ? { name: party.name, personId: party.personId } : { name: party.name }
      })
      payload = { ...was, title: field(formData, 'title'), people }
    }

    await acceptEdited(db, actor, proposal.id, payload)
  })
}

/**
 * Accept, with what the short form asked for filled in: an owner, a project,
 * a due date. Only the fields it asked for are touched; any left blank stay
 * unset.
 */
export async function acceptWithAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    const asked = new Set(values(formData, 'asked'))
    const was = proposal.payload
    if (was.type !== 'item' && was.type !== 'document') {
      await acceptProposal(db, actor, proposal.id)
      return
    }
    const projectId = asked.has('project') ? field(formData, 'projectId') || null : was.projectId
    let payload: ProposalPayload
    if (was.type === 'item') {
      const owners = asked.has('owner') ? await partiesFrom(formData, 'owners', 'owner', await contextId()) : []
      payload = {
        ...was,
        parties: [...was.parties, ...owners],
        projectId,
        dueOn: asked.has('due') ? parseDay(field(formData, 'dueOn')) : was.dueOn,
      }
    } else {
      payload = { ...was, projectId }
    }
    await acceptEdited(db, actor, proposal.id, payload)
  })
}

/**
 * Say who a name is, from a picker: someone in the directory, a group of this
 * context, or a new person or group by the name as completed. Every party of
 * the proposal still carrying only that name is settled at once.
 */
export async function resolvePartyAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    const context = await contextId()
    const name = field(formData, 'name')
    const same = (other: string) => normalise(other) === normalise(name)

    // The name itself rides in the picker as its unsettled chip; it says nobody.
    const picked = new FormData()
    for (const value of values(formData, 'party')) if (!value.startsWith('name:')) picked.append('party', value)
    for (const extra of ['partyText', 'partyNew']) {
      const value = formData.get(extra)
      if (value !== null) picked.set(extra, value)
    }
    const takesGroups = proposal.payload.type === 'item'
    // One answer, counted before anything new is made for it.
    const answers = picked.getAll('party').length + typed(formData, 'partyText').length
    if (answers === 0) throw new ValidationError(`Pick who ${name} is.`)
    if (answers > 1) throw new ValidationError(`Pick one for ${name}.`)
    const { people, groups } = await pickedParties(db, picked, 'party', takesGroups ? context : null)
    const ids = [...people, ...groups]
    // Looked up by id, in this context: a group from elsewhere finds nothing.
    const who = await resolveParty(db, context, ids[0]!)

    const was = proposal.payload
    let payload: ProposalPayload
    if (was.type === 'item') {
      payload = {
        ...was,
        parties: was.parties.map((party) => {
          if (party.personId || party.groupId || !same(party.name)) return party
          return who.type === 'person'
            ? { role: party.role, name: who.name, personId: who.id }
            : { role: party.role, name: who.name, groupId: who.id }
        }),
      }
    } else if (was.type === 'stub') {
      if (who.type !== 'person') throw new ValidationError('A meeting is with people, not a group.')
      payload = {
        ...was,
        people: was.people.map((person) =>
          person.personId || !same(person.name) ? person : { name: who.name, personId: who.id },
        ),
      }
    } else {
      throw new ValidationError('There is nobody to name on this.')
    }

    await editProposal(db, actor, proposal.id, payload)
  })
}

// ─── people the note names ───────────────────────────────────────────────────

/**
 * Say who an address in the note belongs to: someone in the directory, or a
 * new person by the name given, and they are put on the meeting; or nobody.
 */
export async function nameAttendeeAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const meeting = await ownMeeting(field(formData, 'meetingId'))
    const email = field(formData, 'email')
    // Not someone to keep: the address is not offered on this meeting again.
    if (formData.get('skip')) {
      await dismissAttendee(db, meeting.id, email)
      return
    }
    if (formData.get('create')) {
      await nameAttendee(db, actor, meeting.id, email, { name: field(formData, 'name') })
      return
    }
    const [type, id] = field(formData, 'party').split(':')
    if (type === 'group' && id) {
      await attendeeIsGroup(db, meeting.id, email, id)
      return
    }
    if (type !== 'person' || !id) throw new ValidationError('Pick who this is.')
    await nameAttendee(db, actor, meeting.id, email, { personId: id })
  })
}
