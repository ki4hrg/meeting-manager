'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/guards'
import { placeItem } from '@/lib/agenda/candidates'
import { ValidationError, inTransaction } from '@/lib/core/types'
import { db } from '@/lib/db'
import { createContext, getContext, renameContext } from '@/lib/directory/contexts'
import { addMember, createGroup, removeMember, renameGroup } from '@/lib/directory/groups'
import {
  addPersonEmail,
  createPerson,
  makePrimaryEmail,
  removePersonEmail,
  updatePerson,
} from '@/lib/directory/people'
import { captureLine, type CapturePresets } from '@/lib/items/capture'
import {
  ITEM_KINDS,
  addItemParty,
  addNote,
  answerItem,
  completeItem,
  convertItem,
  deleteItem,
  dropItem,
  getItem,
  isOpen,
  recordDecision,
  removeItemParty,
  reopenItem,
  setItemTarget,
  supersedeDecision,
  updateItem,
  type ItemKind,
  type ItemTarget,
} from '@/lib/items/items'
import {
  PROJECT_STATUSES,
  addLink,
  addMilestone,
  createProject,
  deleteLink,
  deleteMilestone,
  updateProject,
  type ProjectStatus,
} from '@/lib/projects/projects'
import { getMeeting } from '@/lib/meetings/meetings'
import { act, field, partyRef, pickedPeople, type ActionResult } from '@/lib/web/action'
import { CONTEXT_COOKIE, contextCookieOptions, currentContext } from '@/lib/web/context'

// ─── contexts ────────────────────────────────────────────────────────────────

export async function switchContextAction(contextId: string): Promise<void> {
  await requireUser()
  const context = await getContext(db, contextId)
  ;(await cookies()).set(CONTEXT_COOKIE, context.id, contextCookieOptions)
  /* Home, not the page they were on: a project or group page belongs to the
     context being left. */
  redirect('/')
}

export async function createContextAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const context = await createContext(db, { name: field(formData, 'name') })
    ;(await cookies()).set(CONTEXT_COOKIE, context.id, contextCookieOptions)
  })
}

export async function renameContextAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await renameContext(db, field(formData, 'id'), field(formData, 'name'))
  })
}

// ─── items ───────────────────────────────────────────────────────────────────

function kindFrom(value: string): ItemKind {
  if (!ITEM_KINDS.includes(value as ItemKind)) throw new ValidationError('Pick a kind.')
  return value as ItemKind
}

export async function captureAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    let presets: CapturePresets
    try {
      presets = JSON.parse(field(formData, 'presets') || '{}') as CapturePresets
    } catch {
      throw new ValidationError('That could not be added. Reload the page and try again.')
    }

    /* A follow-up goes where its parent is; anything else goes to the context
       selected in the bar. */
    const contextId = presets.parentItemId
      ? (await getItem(db, presets.parentItemId)).contextId
      : presets.targetMeetingId
        ? (await getMeeting(db, presets.targetMeetingId)).contextId
        : (await currentContext())?.id
    if (!contextId) throw new ValidationError('Create a context first.')

    await inTransaction(db, async (tx) => {
      const item = await captureLine(tx, actor, { contextId, line: field(formData, 'line'), presets })
      // Added from a meeting's page: on its agenda at once, whenever the meeting is.
      if (presets.targetMeetingId && isOpen(item)) {
        await placeItem(tx, actor, presets.targetMeetingId, item.id)
      }
    })
  })
}

export async function updateItemAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await updateItem(db, actor, field(formData, 'id'), {
      text: field(formData, 'text'),
      detail: field(formData, 'detail'),
      projectId: field(formData, 'projectId') || null,
      dueOn: field(formData, 'dueOn') || null,
    })
  })
}

export async function itemStatusAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const id = field(formData, 'id')
    const op = field(formData, 'op')
    if (op === 'done') await completeItem(db, actor, id)
    else if (op === 'drop') await dropItem(db, actor, id)
    else if (op === 'reopen') await reopenItem(db, actor, id)
    else throw new ValidationError('Unknown change.')
  })
}

export async function deleteItemAction(formData: FormData): Promise<ActionResult> {
  const result = await act(async (actor) => {
    await deleteItem(db, actor, field(formData, 'id'))
  })
  if (!result.error) redirect('/inbox')
  return result
}

export async function answerItemAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await answerItem(db, actor, field(formData, 'id'), {
      answer: field(formData, 'answer'),
      reportTo: partyRef(field(formData, 'reportTo')),
    })
  })
}

export async function convertItemAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await convertItem(db, actor, field(formData, 'id'), kindFrom(field(formData, 'kind')))
  })
}

export async function recordDecisionAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await recordDecision(db, actor, {
      fromItemId: field(formData, 'fromItemId'),
      text: field(formData, 'text'),
      detail: field(formData, 'detail'),
      reportTo: partyRef(field(formData, 'reportTo')),
    })
  })
}

export async function supersedeDecisionAction(formData: FormData): Promise<ActionResult> {
  let replacementId = ''
  const result = await act(async (actor) => {
    const replacement = await supersedeDecision(db, actor, field(formData, 'id'), {
      text: field(formData, 'text'),
      detail: field(formData, 'detail'),
    })
    replacementId = replacement.id
  })
  // On to the decision that now stands.
  if (!result.error) redirect(`/items/${replacementId}`)
  return result
}

export async function addPartyAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const party = partyRef(field(formData, 'party'))
    if (!party) throw new ValidationError('Pick a person or a group.')
    const role = field(formData, 'role') === 'owner' ? 'owner' : 'with'
    await addItemParty(db, actor, field(formData, 'id'), { ...party, role })
  })
}

export async function removePartyAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const party = partyRef(field(formData, 'party'))
    if (!party) throw new ValidationError('Pick a person or a group.')
    await removeItemParty(db, actor, field(formData, 'id'), party)
  })
}

export async function addNoteAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await addNote(db, actor, field(formData, 'id'), field(formData, 'text'))
  })
}

/* "Raise at": `meeting:<id>`, `series:<id>`, `project:<id>` (its next meeting), or nothing. */
export async function setItemTargetAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const [type, id] = field(formData, 'target').split(':')
    let target: ItemTarget
    if (!type) target = null
    else if (type === 'meeting' && id) target = { meetingId: id }
    else if (type === 'series' && id) target = { seriesId: id }
    else if (type === 'project' && id) target = { projectId: id }
    else throw new ValidationError('Pick a meeting, a series or a project.')
    await setItemTarget(db, actor, field(formData, 'id'), target)
  })
}

// ─── people and groups ───────────────────────────────────────────────────────

export async function createPersonAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await createPerson(db, { name: field(formData, 'name'), email: field(formData, 'email') })
  })
}

export async function updatePersonAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await updatePerson(db, field(formData, 'id'), { name: field(formData, 'name') })
  })
}

export async function addPersonEmailAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await addPersonEmail(db, field(formData, 'personId'), field(formData, 'email'))
  })
}

export async function removePersonEmailAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await removePersonEmail(db, field(formData, 'personId'), field(formData, 'email'))
  })
}

export async function primaryEmailAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await makePrimaryEmail(db, field(formData, 'personId'), field(formData, 'email'))
  })
}

export async function createGroupAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const context = await currentContext()
    if (!context) throw new ValidationError('Create a context first.')
    await createGroup(db, { contextId: context.id, name: field(formData, 'name') })
  })
}

export async function renameGroupAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await renameGroup(db, field(formData, 'id'), field(formData, 'name'))
  })
}

export async function addMemberAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await inTransaction(db, async (tx) => {
      const personIds = await pickedPeople(tx, formData, 'people')
      if (personIds.length === 0) throw new ValidationError('Pick a person.')
      for (const personId of personIds) await addMember(tx, field(formData, 'groupId'), personId)
    })
  })
}

export async function removeMemberAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await removeMember(db, field(formData, 'groupId'), field(formData, 'personId'))
  })
}

// ─── projects ────────────────────────────────────────────────────────────────

export async function createProjectAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const context = await currentContext()
    if (!context) throw new ValidationError('Create a context first.')
    await createProject(db, {
      contextId: context.id,
      name: field(formData, 'name'),
      description: field(formData, 'description'),
      parentId: field(formData, 'parentId') || null,
    })
  })
}

export async function updateProjectAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const status = field(formData, 'status') as ProjectStatus
    if (!PROJECT_STATUSES.includes(status)) throw new ValidationError('Pick a status.')
    await updateProject(db, field(formData, 'id'), {
      name: field(formData, 'name'),
      description: field(formData, 'description'),
      status,
      ...(formData.has('parentId') ? { parentId: field(formData, 'parentId') || null } : {}),
    })
  })
}

export async function addMilestoneAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await addMilestone(db, {
      projectId: field(formData, 'projectId'),
      title: field(formData, 'title'),
      dueOn: field(formData, 'dueOn'),
    })
  })
}

export async function deleteMilestoneAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await deleteMilestone(db, field(formData, 'id'))
  })
}

export async function addLinkAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await addLink(db, {
      projectId: field(formData, 'projectId'),
      url: field(formData, 'url'),
      label: field(formData, 'label'),
    })
  })
}

export async function deleteLinkAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await deleteLink(db, field(formData, 'id'))
  })
}
