/*
 * An agenda, pasted.
 *
 * The way an agenda actually arrives is as text somebody already wrote — in a
 * note, in an email, in last month's minutes. Retyping it into a form one item
 * at a time is the friction that stops an agenda getting built at all, and the
 * structure is already there in the headings.
 *
 * So: headings are items and everything else is the body of the item above it.
 *
 *     # Welcome                 →  a section
 *     ## Schedule overview      →  a topic under it
 *     - Now: meeting            →  that topic's body, kept as written
 *
 * **The body is the source text, not a re-render of it.** Bodies are Markdown
 * (lib/markdown/parse.ts), so the bullets under a heading are already in the
 * form they will be stored and shown in. Round-tripping them through the parser
 * to print them back out would be a lossy no-op.
 *
 * This module only reads. Nothing here writes a row — the caller decides
 * whether the parse was what somebody meant, which is what makes a preview
 * possible before anything is created.
 */

export const MAX_DEPTH = 2

export type OutlineItem = {
  title: string
  /** Markdown, exactly as it was pasted. Empty when the heading had nothing under it. */
  body: string
  /** 0 for a section, 1 for a topic, 2 for a part of one. */
  depth: number
  /** Minutes, if the title ends with them: "title 15", "title 15 min". Null otherwise. */
  minutes: number | null
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const BULLET = /^(\s*)[-*+]\s+(.+)$/
const FENCE = /^\s{0,3}(?:```|~~~)/
/* Minutes are read only from the end of a title ("Budget 15", "Budget 15 min",
   "Budget (15m)"): a number anywhere else is part of the title ("3 proposals",
   "the 2026 budget"). */
const MINUTES_PATTERN = /\s+\(?(\d{1,3})\s*(?:m|mins?|minutes?)?\)?\s*$/i

function extractMinutes(title: string): { title: string; minutes: number | null } {
  const match = MINUTES_PATTERN.exec(title)
  if (!match) return { title, minutes: null }
  const cleaned = title.slice(0, match.index).trim()
  // A title that is nothing but a number is a title.
  if (cleaned === '') return { title, minutes: null }
  return { title: cleaned, minutes: Number(match[1]) }
}

export function parseOutline(source: string): OutlineItem[] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const headed = lines.some((line) => HEADING.test(line) && !insideFence(lines, line))

  return headed ? fromHeadings(lines) : fromBullets(lines)
}

/**
 * Headings are the items.
 *
 * A level is a *relative* instruction rather than an absolute one: an outline
 * that starts at `##` because it was copied out of the middle of a document
 * should produce sections, not topics with no section. So the first heading is
 * depth 0 whatever it is, and each later one is placed relative to the one
 * before it — one deeper at most, however many `#` were skipped, because there
 * is no such thing as a topic whose section does not exist.
 */
function fromHeadings(lines: string[]): OutlineItem[] {
  const items: OutlineItem[] = []
  const body: string[] = []
  let baseLevel: number | null = null
  let lastLevel = 0
  let lastDepth = 0
  let fenced = false

  const settle = () => {
    if (items.length === 0) return
    items[items.length - 1]!.body = body.join('\n').trim()
    body.length = 0
  }

  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced

    const heading = fenced ? null : HEADING.exec(line)
    if (!heading) {
      body.push(line)
      continue
    }

    settle()

    const level = heading[1]!.length
    if (baseLevel === null) {
      baseLevel = level
      lastLevel = level
      lastDepth = 0
    } else if (level > lastLevel) {
      lastDepth = Math.min(lastDepth + 1, MAX_DEPTH)
    } else if (level < lastLevel) {
      /* Back out by however many levels were closed, but never above the top
         and never below where this outline started. */
      lastDepth = Math.max(0, lastDepth - (lastLevel - level))
    }
    lastLevel = level

    const titleText = heading[2]!.trim()
    const { title, minutes } = extractMinutes(titleText)
    items.push({ title, body: '', depth: lastDepth, minutes })
  }

  settle()
  return items.filter((item) => item.title !== '')
}

/**
 * No headings anywhere — so the bullets are the outline.
 *
 * Only when there is not a single heading in the paste. Under a heading,
 * bullets are a list in a body and turning them into items would shred exactly
 * the case this exists to serve.
 */
function fromBullets(lines: string[]): OutlineItem[] {
  const items: OutlineItem[] = []
  const indents: number[] = []
  const body: string[] = []
  let fenced = false

  const settle = () => {
    if (items.length === 0) return
    items[items.length - 1]!.body = body.join('\n').trim()
    body.length = 0
  }

  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced

    const bullet = fenced ? null : BULLET.exec(line)
    if (!bullet) {
      if (line.trim() !== '') body.push(line.trim())
      continue
    }

    settle()

    const indent = bullet[1]!.length
    /* Indents are matched to the levels already seen rather than divided by a
       fixed width: two spaces, four spaces and a tab are all one level down,
       and which one this paste used is whatever it used consistently. */
    while (indents.length > 0 && indent < indents[indents.length - 1]!) indents.pop()
    if (indents.length === 0 || indent > indents[indents.length - 1]!) indents.push(indent)

    const titleText = bullet[2]!.trim()
    const { title, minutes } = extractMinutes(titleText)
    items.push({
      title,
      body: '',
      depth: Math.min(indents.length - 1, MAX_DEPTH),
      minutes,
    })
  }

  settle()
  return items.filter((item) => item.title !== '')
}

/** Whether this line falls inside a fenced code block. */
function insideFence(lines: string[], target: string): boolean {
  let fenced = false
  for (const line of lines) {
    if (line === target) return fenced
    if (FENCE.test(line)) fenced = !fenced
  }
  return false
}
