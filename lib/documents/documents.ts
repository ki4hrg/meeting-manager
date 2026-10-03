/*
 * Working documents: drafted content kept whole (a brainstormed agenda, a
 * letter), shown on its project's hub. Each belongs to one context, and its
 * project and meeting, when it has them, sit in the same one.
 */

import { and, desc, eq } from 'drizzle-orm'
import { NotFoundError, ValidationError, type ActorContext, type Executor } from '../core/types'
import { documents, meetings, projects } from '../db/schema'
import { notDeleted } from '../db/shelf'
import { getContext } from '../directory/contexts'

export type Document = typeof documents.$inferSelect

async function assertProjectIn(exec: Executor, projectId: string, contextId: string) {
  const [project] = await exec
    .select({ contextId: projects.contextId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) throw new NotFoundError('Project', projectId)
  if (project.contextId !== contextId) {
    throw new ValidationError('That project belongs to another context.')
  }
}

async function assertMeetingIn(exec: Executor, meetingId: string, contextId: string) {
  const [meeting] = await exec
    .select({ contextId: meetings.contextId })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
  if (meeting.contextId !== contextId) {
    throw new ValidationError('That meeting belongs to another context.')
  }
}

export async function getDocument(exec: Executor, id: string): Promise<Document> {
  const [row] = await exec
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), notDeleted(documents)))
    .limit(1)
  if (!row) throw new NotFoundError('Document', id)
  return row
}

/** A context's documents, or one project's, most recently changed first. */
export async function listDocuments(
  exec: Executor,
  filter: { contextId: string; projectId?: string },
): Promise<Document[]> {
  return exec
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.contextId, filter.contextId),
        notDeleted(documents),
        filter.projectId ? eq(documents.projectId, filter.projectId) : undefined,
      ),
    )
    .orderBy(desc(documents.updatedAt), desc(documents.createdAt))
}

export async function createDocument(
  exec: Executor,
  _actor: ActorContext,
  input: {
    contextId: string
    title: string
    body?: string | null
    projectId?: string | null
    /** The meeting it was drafted in. */
    meetingId?: string | null
  },
): Promise<Document> {
  const title = input.title.trim()
  if (title === '') throw new ValidationError('Enter a title.')
  await getContext(exec, input.contextId)
  if (input.projectId) await assertProjectIn(exec, input.projectId, input.contextId)
  if (input.meetingId) await assertMeetingIn(exec, input.meetingId, input.contextId)

  const [row] = await exec
    .insert(documents)
    .values({
      contextId: input.contextId,
      projectId: input.projectId ?? null,
      meetingId: input.meetingId ?? null,
      title,
      body: input.body ?? '',
    })
    .returning()
  return row!
}

export async function updateDocument(
  exec: Executor,
  _actor: ActorContext,
  id: string,
  input: { title?: string; body?: string; projectId?: string | null },
): Promise<Document> {
  const document = await getDocument(exec, id)
  const patch: Partial<typeof documents.$inferInsert> = {}

  if (input.title !== undefined) {
    const title = input.title.trim()
    if (title === '') throw new ValidationError('Enter a title.')
    patch.title = title
  }
  if (input.body !== undefined) patch.body = input.body
  if (input.projectId !== undefined) {
    const projectId = input.projectId || null
    if (projectId) await assertProjectIn(exec, projectId, document.contextId)
    patch.projectId = projectId
  }

  const [row] = await exec
    .update(documents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(documents.id, id))
    .returning()
  return row!
}

/** Kept 30 days for Restore on Settings (lib/archive). */
export async function deleteDocument(exec: Executor, _actor: ActorContext, id: string): Promise<void> {
  await getDocument(exec, id)
  await exec.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, id))
}

/** Gone at once, for an accepted proposal taken back: it never was. */
export async function discardDocument(exec: Executor, id: string): Promise<void> {
  await exec.delete(documents).where(eq(documents.id, id))
}
