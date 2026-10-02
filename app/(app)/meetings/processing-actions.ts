'use server'

import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { fromLocalInput, parseDay } from '@/lib/core/dates'
import { normalise } from '@/lib/core/match'
import { AppError, ValidationError } from '@/lib/core/types'
import { db } from '@/lib/db'
import type { ProposalPayload, ProposedParty } from '@/lib/db/schema'
import { createPerson } from '@/lib/directory/people'
import { resolveParty, resolvePerson } from '@/lib/directory/resolve'
import { ITEM_KINDS } from '@/lib/items/items'
import { PROCESS_NOTES, kick } from '@/lib/jobs'
import { logMeeting } from '@/lib/meetings/log'
import { getMeeting } from '@/lib/meetings/meetings'
import { dismissAttendee, nameAttendee } from '@/lib/notes/attendees'
import { getNote, moveNote, saveNote } from '@/lib/notes/notes'
import {
  acceptProposal,
  approveAll,
  editProposal,
  getProposal,
  rejectProposal,
  undoProposal,
  type ProposalView,
} from '@/lib/processing/proposals'
import { queueRun, reprocessMeeting } from '@/lib/processing/run'
import { act, field, type ActionResult } from '@/lib/web/action'
import { currentContext } from '@/lib/web/context'

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
    const personIds = values(formData, 'people')
    // A name typed and not picked resolves as it does everywhere, or is refused by name.
    for (const name of typed(formData, 'peopleText')) {
      personIds.push((await resolvePerson(db, name)).id)
    }

    const starts = field(formData, 'startsAt')
    const length = field(formData, 'length')
    const minutes = length === '' ? null : Number(length)
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) {
      throw new ValidationError('Minutes are a whole number.')
    }

    const { meeting } = await logMeeting(db, actor, {
      contextId: await contextId(),
      title: field(formData, 'title') || undefined,
      startsAt: starts === '' ? null : fromLocalInput(starts, user.timeZone),
      minutes,
      personIds: [...new Set(personIds)],
      groupId: field(formData, 'groupId') || null,
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
    await ownMeeting(note.meetingId)
    const to = await ownMeeting(field(formData, 'meetingId'))
    await moveNote(db, actor, note.id, to.id)
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
 * The parties a picker submits under `name`: `person:<id>`, `group:<id>`, or
 * `name:<text>` for one that is still only a name. Whatever was typed and not
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

/** The edit form over a pending proposal's payload. What the form does not show is kept. */
export async function editProposalAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    const context = await contextId()
    const was = proposal.payload
    let payload: ProposalPayload

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

    await editProposal(db, actor, proposal.id, payload)
  })
}

/**
 * Say who a name is: someone in the directory, a group of this context, or a
 * new person by that name. Every party of the proposal still carrying only
 * that name is settled at once.
 */
export async function resolvePartyAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const proposal = await ownProposal(field(formData, 'id'))
    const context = await contextId()
    const name = field(formData, 'name')
    const same = (other: string) => normalise(other) === normalise(name)

    let who: { type: 'person' | 'group'; id: string; name: string }
    if (formData.get('create')) {
      const person = await createPerson(db, { name })
      who = { type: 'person', id: person.id, name: person.name }
    } else {
      const [, id] = field(formData, 'party').split(':')
      if (!id) throw new ValidationError('Pick who this is.')
      // Looked up by id, in this context: a group from elsewhere finds nothing.
      who = await resolveParty(db, context, id)
    }

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
    if (type !== 'person' || !id) throw new ValidationError('Pick who this is.')
    await nameAttendee(db, actor, meeting.id, email, { personId: id })
  })
}
