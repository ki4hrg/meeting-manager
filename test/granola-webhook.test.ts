/*
 * Deliveries from Granola: refused unless signed, claimed once, and filed.
 * Mostly through `receiveDelivery`, which is everything the Route Handler
 * does; the handler itself is called at the end, to prove it authenticates.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { integrationEvents, meetings, notes, processingRuns } from '../lib/db/schema'
import { receiveDelivery } from '../lib/connect/granola/webhook'
import { databaseUrl, db, resetBetweenTests } from './helpers/db'
import { makeWorld } from './helpers/fixtures'
import {
  TEST_KEY,
  connect,
  delivery,
  fakeGranola,
  folder,
  note,
  noteId,
} from './helpers/granola'

/* The handler imports `@/lib/db`, which reads this on first use. */
process.env.DATABASE_URL = databaseUrl

const kick = vi.fn<(name: string) => Promise<object>>(async () => ({}))
vi.mock('@/lib/jobs', () => ({ kick: (name: string) => kick(name), PROCESS_NOTES: 'process-notes' }))

resetBetweenTests()
afterEach(() => {
  vi.unstubAllGlobals()
  kick.mockClear()
})

const PARISH = 'fol_parish00000000'
const parishFolder = folder(PARISH, 'Parish')
const OTHER_SECRET = `whsec_${Buffer.from('some-other-secret-entirely-here!').toString('base64')}`

async function setUp() {
  const world = await makeWorld()
  const granola = fakeGranola({ folders: [parishFolder] })
  const account = await connect([{ folderId: PARISH, contextId: world.parish.id }])
  const id = noteId()
  granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })
  granola.calls.length = 0
  return { ...world, granola, account, id }
}

const events = () => db.select().from(integrationEvents)
const generated = (id: string) => ({ type: 'note.generated', data: { id } })

describe('signature', () => {
  it('refuses an unsigned, a wrongly signed, a tampered and a stale delivery, storing nothing', async () => {
    const { granola, id } = await setUp()
    const good = delivery(generated(id))

    const unsigned = await receiveDelivery(db, { headers: new Headers(), body: good.body })
    const wrong = await receiveDelivery(db, delivery(generated(id), { secret: OTHER_SECRET }))
    const tampered = await receiveDelivery(db, { headers: good.headers, body: good.body.replace(id, noteId()) })
    const stale = await receiveDelivery(db, delivery(generated(id), { at: new Date(Date.now() - 10 * 60_000) }))

    for (const result of [unsigned, wrong, tampered, stale]) {
      expect(result).toMatchObject({ status: 401, queued: false })
    }
    // Nothing was claimed, nothing was asked of Granola, nothing was made.
    expect(await events()).toEqual([])
    expect(granola.calls).toEqual([])
    expect(await db.select().from(meetings)).toEqual([])
    expect(await db.select().from(notes)).toEqual([])
  })

  it('answers 404 when no secret is held at all', async () => {
    await makeWorld()
    fakeGranola()
    expect((await receiveDelivery(db, delivery(generated(noteId())))).status).toBe(404)
  })

  it('never takes the note from the payload: what it files is what Granola says', async () => {
    const { parish, id } = await setUp()
    const result = await receiveDelivery(
      db,
      delivery({ type: 'note.generated', data: { id, title: 'Forged', summary_markdown: 'Forged' } }),
    )

    expect(result).toMatchObject({ status: 200, queued: true })
    const [meeting] = await db.select().from(meetings)
    expect(meeting).toMatchObject({ contextId: parish.id, title: 'Untitled' })
    expect((await db.select().from(notes))[0]!.summary).toBe('We talked.')
  })
})

describe('delivery', () => {
  it('files the note, records the delivery, and asks for the job', async () => {
    const { id } = await setUp()
    const sent = delivery(generated(id))

    const result = await receiveDelivery(db, sent)

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: 'filed' }, queued: true })
    const [event] = await events()
    expect(event).toMatchObject({
      provider: 'granola',
      externalId: sent.id,
      type: 'note.generated',
      status: 'processed',
      detail: 'Made a meeting of its own.',
    })
    expect(event!.processedAt).not.toBeNull()
    expect(await db.select().from(processingRuns)).toHaveLength(1)
  })

  it('a delivery sent twice does its work once', async () => {
    const { granola, id } = await setUp()
    const sent = delivery(generated(id))

    await receiveDelivery(db, sent)
    const asked = granola.calls.length
    const again = await receiveDelivery(db, sent)

    expect(again).toEqual({ status: 200, body: { ok: true, replay: true }, queued: false })
    expect(granola.calls.length).toBe(asked)
    expect(await events()).toHaveLength(1)
    expect(await db.select().from(meetings)).toHaveLength(1)
    expect(await db.select().from(notes)).toHaveLength(1)
    expect(await db.select().from(processingRuns)).toHaveLength(1)
  })

  it('the same note under a new delivery id, unchanged: nothing new', async () => {
    const { id } = await setUp()
    await receiveDelivery(db, delivery(generated(id)))

    const again = await receiveDelivery(db, delivery({ type: 'note.edited', data: { id } }))

    expect(again).toMatchObject({ status: 200, queued: false })
    expect(await events()).toHaveLength(2)
    expect((await events()).map((event) => event.detail).sort()).toEqual([
      'Already held, unchanged.',
      'Made a meeting of its own.',
    ])
    expect(await db.select().from(meetings)).toHaveLength(1)
    expect(await db.select().from(processingRuns)).toHaveLength(1)
  })

  it('an edited note re-delivered: the same note, a new run', async () => {
    const { granola, id } = await setUp()
    await receiveDelivery(db, delivery(generated(id)))

    granola.script.notes[id] = { ...granola.script.notes[id]!, summary_markdown: 'We talked, and decided.' }
    const edited = await receiveDelivery(db, delivery({ type: 'note.edited', data: { id } }))

    expect(edited).toMatchObject({ status: 200, queued: true })
    const saved = await db.select().from(notes)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.summary).toBe('We talked, and decided.')
    expect(await db.select().from(meetings)).toHaveLength(1)
    expect(await db.select().from(processingRuns)).toHaveLength(2)
  })

  it('a note outside the bound folders is recorded as ignored and makes nothing', async () => {
    const { granola } = await setUp()
    const stray = noteId()
    granola.script.notes[stray] = note({ id: stray, folder_membership: [folder('fol_other000000000', 'Personal')] })

    const result = await receiveDelivery(db, delivery(generated(stray)))

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' }, queued: false })
    expect((await events())[0]).toMatchObject({ status: 'ignored', detail: 'The note is in no folder that feeds a context.' })
    expect(await db.select().from(meetings)).toEqual([])
  })

  it('finds the note id wherever the payload puts it, and shrugs when there is none', async () => {
    const { id } = await setUp()
    const nested = await receiveDelivery(db, delivery({ event: 'note.generated', payload: { note: { ref: id } } }))
    expect(nested.body).toEqual({ ok: true, outcome: 'filed' })

    const none = await receiveDelivery(db, delivery({ type: 'ping' }))
    expect(none).toMatchObject({ status: 200, queued: false })
    const unparsed = await receiveDelivery(db, delivery(null, { raw: 'not json' }))
    expect(unparsed.status).toBe(200)
    expect((await events()).filter((event) => event.status === 'ignored')).toHaveLength(2)
  })

  it('a failure is recorded, asks Granola to redeliver when that could help, and the redelivery runs', async () => {
    const { granola, id } = await setUp()
    const sent = delivery(generated(id))

    granola.script.failWith.push({ status: 503 })
    const failed = await receiveDelivery(db, sent)

    expect(failed).toMatchObject({ status: 503, queued: false })
    expect((await events())[0]).toMatchObject({ status: 'failed' })
    expect(await db.select().from(meetings)).toEqual([])

    const retried = await receiveDelivery(db, sent)

    expect(retried).toMatchObject({ status: 200, queued: true })
    expect(await events()).toHaveLength(1)
    expect((await events())[0]).toMatchObject({ status: 'processed' })
    expect(await db.select().from(meetings)).toHaveLength(1)
  })

  it('a revoked key fails the delivery without asking for a redelivery', async () => {
    const { granola, id } = await setUp()
    granola.script.key = 'grn_other'

    const result = await receiveDelivery(db, delivery(generated(id)))

    expect(result).toMatchObject({ status: 200, body: { ok: false, deferred: true } })
    expect((await events())[0]!.status).toBe('failed')
    granola.script.key = TEST_KEY
  })
})

describe('POST /api/webhooks/granola', () => {
  const post = async (sent: { headers: Headers; body: string }) => {
    const { POST } = await import('../app/api/webhooks/granola/route')
    return POST(
      new Request('https://meetings.example.test/api/webhooks/granola', {
        method: 'POST',
        headers: sent.headers,
        body: sent.body,
      }),
    )
  }

  it('is not open: no session is needed, and no unsigned request gets in', async () => {
    const { id } = await setUp()

    const refused = await post({ headers: new Headers(), body: JSON.stringify(generated(id)) })
    expect(refused.status).toBe(401)
    const forged = await post(delivery(generated(id), { secret: OTHER_SECRET }))
    expect(forged.status).toBe(401)
    expect(await db.select().from(meetings)).toEqual([])
    expect(kick).not.toHaveBeenCalled()
  })

  it('files a signed delivery and kicks processing without waiting for it', async () => {
    const { id } = await setUp()

    const response = await post(delivery(generated(id)))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, outcome: 'filed' })
    expect(await db.select().from(notes)).toHaveLength(1)
    expect(kick).toHaveBeenCalledExactlyOnceWith('process-notes')
  })
})
