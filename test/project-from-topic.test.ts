/*
 * A topic that turns out to be a project of its own: the project is made from
 * it, proposed unless said otherwise, and the topic moves onto it.
 */

import { describe, expect, it } from 'vitest'
import { createItem, getItem } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { addProposals, getProposal, listProposals } from '../lib/processing/proposals'
import { projectFromProposal, projectFromTopic } from '../lib/projects/from-topic'
import { createProject, getProject } from '../lib/projects/projects'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('making a project from a topic', () => {
  it('makes a proposed sub-project of the topic’s project and moves the topic onto it, still open', async () => {
    const w = await makeWorld()
    const safety = await createProject(db, { contextId: w.parish.id, name: 'Safe Sanctuaries' })
    const topic = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'topic',
      text: 'Vulnerable adults policy update',
      detail: 'The 2019 policy predates the new guidance.',
      projectId: safety.id,
    })

    const { project, topic: moved } = await projectFromTopic(db, actor, topic.id)
    expect(project).toMatchObject({
      contextId: w.parish.id,
      name: 'Vulnerable adults policy update',
      description: 'The 2019 policy predates the new guidance.',
      parentId: safety.id,
      status: 'proposed',
    })
    expect(moved).toMatchObject({ status: 'open', project: { id: project.id } })
  })

  it('takes a name, a parent and a status, and closes the topic when asked', async () => {
    const w = await makeWorld()
    const topic = await createItem(db, actor, { contextId: w.parish.id, kind: 'topic', text: 'Rewrite the policy' })

    const { project } = await projectFromTopic(db, actor, topic.id, {
      name: 'Policy rewrite',
      parentId: null,
      status: 'pending',
      closeTopic: true,
    })
    expect(await getProject(db, project.id)).toMatchObject({ name: 'Policy rewrite', parentId: null, status: 'pending' })
    expect(await getItem(db, topic.id)).toMatchObject({ status: 'done', project: { id: project.id } })

    // Closed, it is a project already; and only a topic becomes one.
    await expect(projectFromTopic(db, actor, topic.id)).rejects.toThrow(/Reopen/)
    const action = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Draft it' })
    await expect(projectFromTopic(db, actor, action.id)).rejects.toThrow(/Only a topic/)
  })

  it('refuses a name another project has, and makes nothing', async () => {
    const w = await makeWorld()
    await createProject(db, { contextId: w.parish.id, name: 'Policy rewrite' })
    const topic = await createItem(db, actor, { contextId: w.parish.id, kind: 'topic', text: 'Policy rewrite' })
    await expect(projectFromTopic(db, actor, topic.id)).rejects.toThrow(/already a project/)
    expect((await getItem(db, topic.id)).project).toBeNull()
  })

  it('from the review screen: accepts a proposed topic on the way, or takes one already accepted', async () => {
    const w = await makeWorld()
    const safety = await createProject(db, { contextId: w.parish.id, name: 'Safe Sanctuaries' })
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Safe Sanctuaries' })
    const topic = (text: string) => ({
      payload: { type: 'item' as const, kind: 'topic' as const, text, parties: [], projectId: safety.id },
    })
    await addProposals(db, { meetingId: meeting.id }, [
      topic('Vulnerable adults policy update'),
      topic('Policy rewrite'),
      { payload: { type: 'item', kind: 'action', text: 'Send the draft', parties: [] } },
    ])
    const [pending, taken, action] = (await listProposals(db, meeting.id)).sort((a, b) => a.position - b.position)

    const { project, topic: made } = await projectFromProposal(db, actor, pending!.id)
    expect(project).toMatchObject({ name: 'Vulnerable adults policy update', parentId: safety.id, status: 'proposed' })
    expect(made).toMatchObject({ kind: 'topic', status: 'open', project: { id: project.id } })
    expect(await getProposal(db, pending!.id)).toMatchObject({ status: 'accepted' })

    // A name already taken refuses it, and the proposal stays pending.
    await expect(projectFromProposal(db, actor, taken!.id, { name: 'Safe Sanctuaries' })).rejects.toThrow(
      /already a project/,
    )
    expect(await getProposal(db, taken!.id)).toMatchObject({ status: 'pending' })

    await expect(projectFromProposal(db, actor, action!.id)).rejects.toThrow(/Only a topic/)
    expect(await getProposal(db, action!.id)).toMatchObject({ status: 'pending' })
  })
})
