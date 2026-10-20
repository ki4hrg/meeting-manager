/*
 * A topic that turns out to be a project of its own: the project is made from
 * it, proposed unless said otherwise, and the topic moves onto it.
 */

import { describe, expect, it } from 'vitest'
import { createItem, getItem } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { acceptAsProject, addProposals, getProposal, listProposals, undoProposal } from '../lib/processing/proposals'
import { projectFromTopic } from '../lib/projects/from-topic'
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

  it('from review: a proposal accepted as a project, with or without a topic kept on it, and undone', async () => {
    const w = await makeWorld()
    const safety = await createProject(db, { contextId: w.parish.id, name: 'Safe Sanctuaries' })
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Safe Sanctuaries' })
    await addProposals(db, { meetingId: meeting.id }, [
      {
        payload: {
          type: 'item',
          kind: 'action',
          text: 'Update the vulnerable adults policy',
          detail: 'The 2019 policy predates the new guidance.',
          parties: [{ role: 'owner', name: 'Sarah', personId: w.sarah.id }],
          projectId: safety.id,
          dueOn: '2026-11-01',
        },
      },
      { payload: { type: 'item', kind: 'topic', text: 'Camp training page', parties: [] } },
    ])
    const [policy, camp] = (await listProposals(db, meeting.id)).sort((a, b) => a.position - b.position)
    if (policy!.payload.type !== 'item' || camp!.payload.type !== 'item') throw new Error('expected items')

    // Kept: the project, and a topic on it with the proposal's people.
    const accepted = await acceptAsProject(db, actor, policy!.id, policy!.payload, {
      name: 'Vulnerable adults policy update',
      parentId: safety.id,
      keepTopic: true,
    })
    const projectId = accepted.result!.projectId!
    expect(await getProject(db, projectId)).toMatchObject({
      name: 'Vulnerable adults policy update',
      description: 'The 2019 policy predates the new guidance.',
      parentId: safety.id,
      status: 'proposed',
    })
    expect(accepted.made?.project).toMatchObject({ id: projectId })
    const topic = await getItem(db, accepted.result!.itemId!)
    expect(topic).toMatchObject({ kind: 'topic', status: 'open', project: { id: projectId } })
    expect(topic.parties.map((party) => party.id)).toEqual([w.sarah.id])

    // Undone: the topic and the project go, and the proposal is back as it was raised, a topic.
    const undone = await undoProposal(db, actor, policy!.id)
    expect(undone).toMatchObject({ status: 'pending', payload: { kind: 'topic' } })
    await expect(getProject(db, projectId)).rejects.toThrow()
    await expect(getItem(db, topic.id)).rejects.toThrow()

    // Not kept: only the project. Once something is on it, Undo refuses rather than lose it.
    const alone = await acceptAsProject(db, actor, camp!.id, camp!.payload, { name: 'Camp training', status: 'pending' })
    expect(alone.result).toEqual({ projectId: alone.result!.projectId })
    expect(await getProject(db, alone.result!.projectId!)).toMatchObject({ status: 'pending', parentId: null })
    await createItem(db, actor, { contextId: w.parish.id, text: 'Find the old files', projectId: alone.result!.projectId! })
    await expect(undoProposal(db, actor, camp!.id)).rejects.toThrow(/things on it/)
    expect(await getProposal(db, camp!.id)).toMatchObject({ status: 'accepted' })
  })

  it('from review: a name already taken refuses it, and the proposal stays pending', async () => {
    const w = await makeWorld()
    await createProject(db, { contextId: w.parish.id, name: 'Safe Sanctuaries' })
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Staff' })
    await addProposals(db, { meetingId: meeting.id }, [
      { payload: { type: 'item', kind: 'topic', text: 'Safe Sanctuaries', parties: [] } },
    ])
    const [proposal] = await listProposals(db, meeting.id)
    if (proposal!.payload.type !== 'item') throw new Error('expected an item')
    await expect(
      acceptAsProject(db, actor, proposal!.id, proposal!.payload, { name: 'Safe Sanctuaries' }),
    ).rejects.toThrow(/already a project/)
    expect(await getProposal(db, proposal!.id)).toMatchObject({ status: 'pending' })
  })
})
