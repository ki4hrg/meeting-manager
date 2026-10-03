'use server'

/* Archive, then delete (lib/archive): one set of actions for every kind. */

import { redirect } from 'next/navigation'
import { after } from 'next/server'
import {
  archive,
  purge,
  restoreDeleted,
  softDelete,
  unarchive,
  type ArchiveKind,
  type DeletedKind,
} from '@/lib/archive/archive'
import { ValidationError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { GRANOLA_RECONCILE, kick } from '@/lib/jobs'
import { getMeeting } from '@/lib/meetings/meetings'
import { act, field, type ActionResult } from '@/lib/web/action'

const ARCHIVABLE: ArchiveKind[] = ['context', 'person', 'group', 'project', 'series', 'meeting']
const DELETABLE: DeletedKind[] = [...ARCHIVABLE, 'item', 'milestone', 'link', 'document']

/* Where a deleted row's page sends you: the list it was on. */
const HUB: Record<ArchiveKind, string> = {
  context: '/contexts',
  person: '/people',
  group: '/groups',
  project: '/projects',
  series: '/series',
  meeting: '/meetings/past',
}

function archiveKind(formData: FormData): ArchiveKind {
  const kind = field(formData, 'kind') as ArchiveKind
  if (!ARCHIVABLE.includes(kind)) throw new ValidationError('That cannot be archived.')
  return kind
}

function deletedKind(formData: FormData): DeletedKind {
  const kind = field(formData, 'kind') as DeletedKind
  if (!DELETABLE.includes(kind)) throw new ValidationError('That cannot be restored.')
  return kind
}

export async function archiveAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await archive(db, archiveKind(formData), field(formData, 'id'))
  })
}

export async function unarchiveAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const kind = archiveKind(formData)
    await unarchive(db, kind, field(formData, 'id'))
    // Notes its folders held for the Inbox are filed now, not at the next pass.
    if (kind === 'context') after(() => kick(GRANOLA_RECONCILE))
  })
}

export async function deleteRecordAction(formData: FormData): Promise<ActionResult> {
  let back: string | undefined
  const result = await act(async () => {
    const kind = archiveKind(formData)
    const id = field(formData, 'id')
    back = HUB[kind]
    // A session goes back to its meeting.
    if (kind === 'meeting') {
      const { parentMeetingId } = await getMeeting(db, id)
      if (parentMeetingId) back = `/meetings/${parentMeetingId}`
    }
    await softDelete(db, kind, id)
  })
  if (!result.error && back) redirect(back)
  return result
}

export async function restoreDeletedAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await restoreDeleted(db, deletedKind(formData), field(formData, 'id'))
  })
}

export async function purgeAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await purge(db, deletedKind(formData), field(formData, 'id'))
  })
}
