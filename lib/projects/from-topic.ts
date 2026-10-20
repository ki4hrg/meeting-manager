/*
 * A topic that turns out to be a project of its own (docs/SPEC.md, "Projects").
 *
 * A meeting raises something that is more than a conversation: a policy to
 * rewrite, a programme to start. The project is made from the topic, within
 * the topic's own project unless another is named, and proposed unless John
 * says it is already agreed to. The topic moves onto it, so it reads as where
 * the project came from, and is closed if John says so; left open, it stays
 * the next thing to raise about it.
 */

import { inTransaction, ValidationError, type ActorContext, type Executor } from '../core/types'
import { completeItem, getItem, isOpen, updateItem, type ItemView } from '../items/items'
import { createProject, type Project, type ProjectStatus } from './projects'

export async function projectFromTopic(
  exec: Executor,
  actor: ActorContext,
  itemId: string,
  input: {
    /** The topic's text when not given. */
    name?: string
    /** Within the topic's project when not given; null for none. */
    parentId?: string | null
    status?: ProjectStatus
    closeTopic?: boolean
  } = {},
): Promise<{ project: Project; topic: ItemView }> {
  return inTransaction(exec, async (tx) => {
    const topic = await getItem(tx, itemId)
    if (topic.kind !== 'topic') throw new ValidationError('Only a topic becomes a project.')
    if (!isOpen(topic)) throw new ValidationError('Reopen this topic first.')

    const project = await createProject(tx, {
      contextId: topic.contextId,
      name: input.name?.trim() || topic.text,
      description: topic.detail,
      parentId: input.parentId === undefined ? (topic.project?.id ?? null) : input.parentId,
      status: input.status ?? 'proposed',
    })
    let moved = await updateItem(tx, actor, topic.id, { projectId: project.id })
    if (input.closeTopic) moved = await completeItem(tx, actor, topic.id)
    return { project, topic: moved }
  })
}

