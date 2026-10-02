/* Working documents: plain records, bound to one context. */

import { describe, expect, it } from 'vitest'
import { NotFoundError, ValidationError } from '../lib/core/types'
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../lib/documents/documents'
import { createMeeting } from '../lib/meetings/meetings'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('documents', () => {
  it('creates, reads, updates and deletes', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Planning' })
    const created = await createDocument(db, actor, {
      contextId: w.parish.id,
      projectId: w.retreat.id,
      meetingId: meeting.id,
      title: '  Retreat agenda ',
      body: '# Day one\n\n- arrive',
    })
    expect(created).toMatchObject({
      contextId: w.parish.id,
      projectId: w.retreat.id,
      meetingId: meeting.id,
      title: 'Retreat agenda',
      body: '# Day one\n\n- arrive',
    })

    const updated = await updateDocument(db, actor, created.id, {
      title: 'Retreat agenda v2',
      body: 'shorter',
      projectId: null,
    })
    expect(updated).toMatchObject({ title: 'Retreat agenda v2', body: 'shorter', projectId: null })
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
    expect((await getDocument(db, created.id)).title).toBe('Retreat agenda v2')

    await deleteDocument(db, actor, created.id)
    await expect(getDocument(db, created.id)).rejects.toThrow(NotFoundError)
    await expect(deleteDocument(db, actor, created.id)).rejects.toThrow(NotFoundError)
  })

  it('lists by context, and by project within it', async () => {
    const w = await makeWorld()
    await createDocument(db, actor, { contextId: w.parish.id, title: 'Loose' })
    await createDocument(db, actor, { contextId: w.parish.id, projectId: w.retreat.id, title: 'Retreat' })
    await createDocument(db, actor, { contextId: w.parish.id, projectId: w.campaign.id, title: 'Campaign' })
    await createDocument(db, actor, { contextId: w.diocese.id, projectId: w.synod.id, title: 'Synod' })

    const parish = await listDocuments(db, { contextId: w.parish.id })
    expect(parish.map((d) => d.title).sort()).toEqual(['Campaign', 'Loose', 'Retreat'])

    const retreat = await listDocuments(db, { contextId: w.parish.id, projectId: w.retreat.id })
    expect(retreat.map((d) => d.title)).toEqual(['Retreat'])

    // Another context's project, asked for from here, lists nothing.
    expect(await listDocuments(db, { contextId: w.parish.id, projectId: w.synod.id })).toEqual([])
  })

  it('refuses a project or a meeting from another context, and an empty title', async () => {
    const w = await makeWorld()
    const elsewhere = await createMeeting(db, actor, { contextId: w.diocese.id, title: 'Council' })

    await expect(
      createDocument(db, actor, { contextId: w.parish.id, projectId: w.synod.id, title: 'x' }),
    ).rejects.toThrow('That project belongs to another context.')
    await expect(
      createDocument(db, actor, { contextId: w.parish.id, meetingId: elsewhere.id, title: 'x' }),
    ).rejects.toThrow('That meeting belongs to another context.')
    await expect(createDocument(db, actor, { contextId: w.parish.id, title: '  ' })).rejects.toThrow(
      ValidationError,
    )

    const doc = await createDocument(db, actor, { contextId: w.parish.id, title: 'Mine' })
    await expect(updateDocument(db, actor, doc.id, { projectId: w.synod.id })).rejects.toThrow(
      'That project belongs to another context.',
    )
    await expect(updateDocument(db, actor, doc.id, { title: '' })).rejects.toThrow(ValidationError)
    expect(await listDocuments(db, { contextId: w.diocese.id })).toEqual([])
  })
})
