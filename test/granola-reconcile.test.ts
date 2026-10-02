/* The reconcile job: what the webhook missed, and nothing it should not see. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { connections, meetings, notes, processingRuns } from '../lib/db/schema'
import { sealCredentials } from '../lib/connect/connections'
import { bindFolder, listGranolaAccounts } from '../lib/connect/granola/connection'
import { granolaActor, ingestNoteById } from '../lib/connect/granola/ingest'
import { LOOKBACK_MS, reconcileGranola, summariseReconcile } from '../lib/connect/granola/reconcile'
import { GRANOLA_RECONCILE, jobNames } from '../lib/jobs'
import { db, resetBetweenTests } from './helpers/db'
import { makeWorld } from './helpers/fixtures'
import { connect, fakeGranola, folder, note, noteId } from './helpers/granola'

resetBetweenTests()
afterEach(() => vi.unstubAllGlobals())

const PARISH = 'fol_parish00000000'
const OTHER = 'fol_other000000000'
const parishFolder = folder(PARISH, 'Parish')
const now = new Date('2026-10-01T18:00:00Z')

async function setUp() {
  const world = await makeWorld()
  const granola = fakeGranola({ folders: [parishFolder, folder(OTHER, 'Personal')] })
  const account = await connect([{ folderId: PARISH, contextId: world.parish.id }])
  granola.calls.length = 0
  return { ...world, granola, account }
}

describe('reconcile', () => {
  it('files a note no delivery ever announced, and queues its run', async () => {
    const { parish, granola } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, title: 'Missed', folder_membership: [parishFolder] })

    const result = await reconcileGranola(db, now)

    expect(result).toEqual({ seen: 1, filed: 1, queued: 1, failed: 0 })
    expect(await db.select().from(meetings)).toMatchObject([{ contextId: parish.id, title: 'Missed' }])
    expect(await db.select().from(processingRuns)).toHaveLength(1)
    expect(summariseReconcile(result)).toBe('1 seen · 1 filed')
  })

  it('lists the whole account, and holds a note outside the bound folders for the Inbox', async () => {
    const { granola } = await setUp()
    const stray = noteId()
    const unfiled = noteId()
    granola.script.notes[stray] = note({ id: stray, folder_membership: [folder(OTHER, 'Personal')] })
    granola.script.notes[unfiled] = note({ id: unfiled })

    const result = await reconcileGranola(db, now)

    // Held, not filed on a meeting, and nothing queued.
    expect(result).toEqual({ seen: 2, filed: 2, queued: 0, failed: 0 })
    const asked = new URL(`https://x${granola.calls[0]!.split(' ')[1]}`)
    expect(asked.pathname).toBe('/v1/notes')
    expect(asked.searchParams.get('folder_id')).toBeNull()
    expect(asked.searchParams.get('page_size')).toBe('30')
    expect(asked.searchParams.get('updated_after')).toBe(new Date(now.getTime() - LOOKBACK_MS).toISOString())
    expect(await db.select().from(meetings)).toEqual([])
    expect((await db.select().from(notes)).map((row) => row.meetingId)).toEqual([null, null])

    // A second pass finds both held as they stand.
    granola.calls.length = 0
    expect(await reconcileGranola(db, now)).toMatchObject({ seen: 2, filed: 0 })
    expect(granola.calls).toHaveLength(1)
  })

  it('does not reach behind its window', async () => {
    const { granola } = await setUp()
    const old = noteId()
    granola.script.notes[old] = note({
      id: old,
      created_at: '2026-09-20T15:00:00Z',
      updated_at: '2026-09-20T15:40:00Z',
      folder_membership: [parishFolder],
    })

    expect((await reconcileGranola(db, now)).seen).toBe(0)
    expect(await db.select().from(meetings)).toEqual([])
  })

  it('a note already held as it stands costs nothing but the listing', async () => {
    const { granola, account } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })
    await ingestNoteById(db, granolaActor('webhook'), account.id, id)
    granola.calls.length = 0

    const result = await reconcileGranola(db, now)

    expect(result).toEqual({ seen: 1, filed: 0, queued: 0, failed: 0 })
    expect(granola.calls).toHaveLength(1)
    expect(await db.select().from(processingRuns)).toHaveLength(1)
  })

  it('picks up an edit whose delivery was lost, as a new version of the same note', async () => {
    const { granola, account } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })
    await ingestNoteById(db, granolaActor('webhook'), account.id, id)

    granola.script.notes[id] = {
      ...granola.script.notes[id]!,
      updated_at: '2026-10-01T17:00:00Z',
      summary_markdown: 'We talked, and decided.',
    }
    const result = await reconcileGranola(db, now)

    expect(result).toMatchObject({ seen: 1, filed: 1, queued: 1 })
    expect(await db.select().from(notes)).toHaveLength(1)
    expect(await db.select().from(meetings)).toHaveLength(1)
    expect(await db.select().from(processingRuns)).toHaveLength(2)

    // And once it is held, the next pass leaves it alone.
    expect(await reconcileGranola(db, now)).toMatchObject({ filed: 0, queued: 0 })
  })

  it('files a note found through two bound folders once, and follows every page', async () => {
    const { parish, granola, account } = await setUp()
    const child = folder('fol_child000000000', 'Staff', PARISH)
    granola.script.folders.push(child)
    await bindFolder(db, { connectionId: account.id, folderId: child.id, name: 'Staff', contextId: parish.id })

    // More than a page of notes, a day apart so none is taken for another's meeting.
    for (let index = 0; index < 32; index++) {
      const id = noteId()
      const at = new Date(now.getTime() - 60 * 60_000 - index * 2 * 60 * 60_000)
      granola.script.notes[id] = note({
        id,
        created_at: at.toISOString(),
        updated_at: at.toISOString(),
        folder_membership: [child],
      })
      granola.script.transcripts[id] = [
        { speaker: null, text: 'Brief.', start_time: at.toISOString(), end_time: new Date(at.getTime() + 60_000).toISOString() },
      ]
    }

    const result = await reconcileGranola(db, now)

    expect(result).toMatchObject({ seen: 32, filed: 32 })
    expect(await db.select().from(notes)).toHaveLength(32)
    expect(await db.select().from(meetings)).toHaveLength(32)
  })

  it('one account’s trouble does not stop the next, and is written on its connection', async () => {
    const { diocese, granola } = await setUp()
    await db.insert(connections).values({
      provider: 'granola',
      account: 'aaa-revoked@example.test',
      credentials: sealCredentials({ apiKey: 'grn_revoked' }),
    })
    const [revoked] = (await listGranolaAccounts(db)).filter((one) => one.account.startsWith('aaa'))
    await bindFolder(db, { connectionId: revoked!.id, folderId: PARISH, name: 'Parish', contextId: diocese.id })

    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    const result = await reconcileGranola(db, now)

    expect(result).toEqual({ seen: 1, filed: 1, queued: 1, failed: 1 })
    const accounts = await listGranolaAccounts(db)
    expect(accounts.find((one) => one.id === revoked!.id)!.lastError).toMatch(/no longer accepts/)
    expect(accounts.find((one) => one.id !== revoked!.id)!.lastError).toBeNull()
    expect(summariseReconcile(result)).toBe('1 seen · 1 filed · 1 failed')
  })

  it('with no account asks Granola nothing; with no bound folder it still looks', async () => {
    const granola = fakeGranola()
    expect(await reconcileGranola(db, now)).toEqual({ seen: 0, filed: 0, queued: 0, failed: 0 })
    expect(granola.calls).toEqual([])

    await makeWorld()
    await connect()
    granola.calls.length = 0
    expect(await reconcileGranola(db, now)).toEqual({ seen: 0, filed: 0, queued: 0, failed: 0 })
    expect(granola.calls).toHaveLength(1)
    expect(summariseReconcile({ seen: 0, filed: 0, queued: 0, failed: 0 })).toBe('Nothing new.')
  })

  it('is a registered job', () => {
    expect(jobNames()).toContain(GRANOLA_RECONCILE)
  })
})
