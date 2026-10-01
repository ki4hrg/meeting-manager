/*
 * Read-only probe of the Granola API, to settle what processing can rely on:
 *
 *   - whether a note with no calendar event is delivered at all
 *   - who it lists as attendees
 *   - whether the user's own typed notes come back separately from the summary
 *
 *   GRANOLA_API_KEY=… pnpm exec tsx scripts/granola-probe.ts
 *
 * Prints shapes and lengths, never note content.
 */

const BASE = 'https://public-api.granola.ai'

const key = process.env.GRANOLA_API_KEY
if (!key) {
  console.error('GRANOLA_API_KEY is not set')
  process.exit(1)
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } })
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`)
  return response.json()
}

type Json = Record<string, unknown>

/** Each key with the type and size of its value, so nothing private is printed. */
function shape(value: unknown): unknown {
  if (value === null) return null
  if (typeof value === 'string') return `string(${value.length})`
  if (Array.isArray(value)) return value.length === 0 ? [] : [`${value.length} ×`, shape(value[0])]
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, shape(v)]))
  }
  return typeof value
}

async function main() {
  // 30 is the documented page-size cap.
  const list = (await get('/v1/notes?page_size=30')) as { notes?: Json[] }
  const notes = list.notes ?? []
  console.log(`listed ${notes.length} notes`)

  const full: Json[] = []
  for (const note of notes) full.push((await get(`/v1/notes/${note.id}`)) as Json)

  const withoutEvent = full.filter((note) => !note.calendar_event)
  console.log(`without a calendar event: ${withoutEvent.length}`)
  console.log(
    `with private notes: ${full.filter((n) => n.private_notes_markdown || n.private_notes_text).length}`,
  )

  const sample = withoutEvent[0] ?? full[0]
  if (!sample) return
  console.log(withoutEvent[0] ? '\nshape of a note with no calendar event:' : '\nshape of a note:')
  console.log(JSON.stringify(shape(sample), null, 2))
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
