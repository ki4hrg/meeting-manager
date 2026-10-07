/*
 * What an export holds, and how it is written out.
 *
 * An agenda or a recap is built once, on the server, as an outline in which
 * every piece a choice can leave out is marked with the part it belongs to.
 * Exporting drops what was not chosen, then writes the rest twice: as
 * Markdown (text/plain) and as HTML (text/html), so a paste keeps its
 * headings and nesting wherever it lands.
 *
 * Nothing here touches the database, so the Export modal runs it in the
 * browser as its toggles change.
 */

import { inlineMarkdownToHtml } from '../core/markdown'

/* A bullet, with whatever is nested under it. A section is a bold bullet whose
   lines are nested, so it is plain where it ends and the loose lines resume. */
export type Entry = {
  text: string
  bold?: boolean
  /** Written by John in Markdown: the HTML copy renders it rather than showing the marks. */
  markdown?: boolean
  sub: Entry[]
}

export type Part =
  | { type: 'h1' | 'h2' | 'p' | 'label'; text: string }
  | { type: 'list'; entries: Entry[] }

// ─── the outline ─────────────────────────────────────────────────────────────

/** Text, or a run of pieces of which some belong to a part. */
export type Piece = string | { only: string; text: string }
type Text = string | Piece[]

export type OutlineEntry = {
  text: Text
  bold?: boolean
  markdown?: boolean
  sub: OutlineEntry[]
  /** Kept only when this part is chosen. */
  only?: string
}

export type OutlinePart = { only?: string } & (
  | { type: 'h1' | 'h2' | 'p' | 'label'; text: Text; /** Between the pieces kept. */ join?: string }
  | { type: 'list'; entries: OutlineEntry[] }
)

/** Marks every part of a run as belonging to `only`. */
export function only<T extends OutlinePart | OutlineEntry>(part: string, items: T[]): Array<T & { only: string }> {
  return items.map((item) => ({ ...item, only: part }))
}

/** The outline with only the chosen parts, ready to write out. */
export function pick(outline: OutlinePart[], chosen: ReadonlySet<string>): Part[] {
  const kept = (item: { only?: string }) => !item.only || chosen.has(item.only)
  const text = (value: Text, join = '') =>
    typeof value === 'string'
      ? value
      : value
          .filter((piece) => typeof piece === 'string' || chosen.has(piece.only))
          .map((piece) => (typeof piece === 'string' ? piece : piece.text))
          .filter((piece) => join === '' || piece !== '')
          .join(join)
  const entries = (list: OutlineEntry[]): Entry[] =>
    list.filter(kept).map((entry) => ({
      text: text(entry.text),
      ...(entry.bold ? { bold: true } : {}),
      ...(entry.markdown ? { markdown: true } : {}),
      sub: entries(entry.sub),
    }))

  const parts: Part[] = []
  for (const part of outline) {
    if (!kept(part)) continue
    if (part.type === 'list') {
      const list = entries(part.entries)
      // A list emptied by the choice goes; one that was always empty stays as it was.
      if (list.length === 0 && part.entries.length > 0) continue
      parts.push({ type: 'list', entries: list })
    } else {
      const written = text(part.text, part.join)
      if (written === '' && typeof part.text !== 'string') continue
      parts.push({ type: part.type, text: written })
    }
  }
  return parts
}

// ─── the kinds of export ─────────────────────────────────────────────────────

export type ExportOption = { key: string; label: string; private?: boolean }
export type ExportPreset = { name: string; parts: string[] }
export type ExportKind = 'agenda' | 'recap'

/* A private part is one the Shareable preset leaves out: what is John's alone,
   or about who owes what. */
export const EXPORTS: Record<ExportKind, { options: ExportOption[]; presets: ExportPreset[] }> = {
  agenda: {
    options: [
      { key: 'attendees', label: 'Attendees' },
      { key: 'times', label: 'Start times' },
      { key: 'details', label: 'Descriptions and leaders' },
      { key: 'notes', label: 'Private notes', private: true },
      { key: 'owed', label: 'Who owes what', private: true },
      { key: 'followUps', label: 'Follow-ups', private: true },
      { key: 'sinceLast', label: 'Since last time', private: true },
      { key: 'lookahead', label: 'Lookahead' },
    ],
    presets: [
      {
        name: 'Private',
        parts: ['attendees', 'times', 'details', 'notes', 'owed', 'followUps', 'sinceLast', 'lookahead'],
      },
      { name: 'Shareable', parts: ['attendees', 'times', 'details', 'lookahead'] },
    ],
  },
  recap: {
    options: [
      { key: 'attendees', label: 'Attendees' },
      { key: 'summary', label: 'Summary' },
      { key: 'discussed', label: 'Discussed' },
      { key: 'decisions', label: 'Decisions' },
      { key: 'followUps', label: 'Follow-ups' },
      { key: 'closed', label: 'Closed' },
      { key: 'lookahead', label: 'Lookahead' },
    ],
    presets: [
      {
        name: 'Shareable',
        parts: ['attendees', 'summary', 'discussed', 'decisions', 'followUps', 'closed', 'lookahead'],
      },
    ],
  },
}

export const preset = (kind: ExportKind, name: string): Set<string> =>
  new Set(EXPORTS[kind].presets.find((one) => one.name === name)?.parts ?? [])

// ─── writing out ─────────────────────────────────────────────────────────────

export function toMarkdown(parts: Part[]): string {
  const out: string[] = []
  const bullets = (entries: Entry[], indent: string) => {
    for (const entry of entries) {
      out.push(`${indent}- ${entry.bold ? `**${entry.text}**` : entry.text}`)
      bullets(entry.sub, `${indent}  `)
    }
  }

  let previous: Part['type'] | null = null
  for (const part of parts) {
    if (part.type === 'list') bullets(part.entries, '')
    else if (part.type === 'h1') out.push(`# ${part.text}`)
    else if (part.type === 'h2') out.push('', `## ${part.text}`)
    else if (part.type === 'label') out.push('', `**${part.text}**`)
    // A paragraph straight after a list would read as part of its last bullet,
    // and one after another paragraph as the same paragraph.
    else if (previous === 'list' || previous === 'p') out.push('', part.text)
    else out.push(part.text)
    previous = part.type
  }
  return out.join('\n')
}

export const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function toHtml(parts: Part[]): string {
  const bullets = (entries: Entry[]): string =>
    entries.length === 0
      ? ''
      : `<ul>${entries
          .map((entry) => {
            const body = entry.markdown ? inlineMarkdownToHtml(entry.text) : escapeHtml(entry.text)
            const text = entry.bold ? `<strong>${body}</strong>` : body
            return `<li>${text}${bullets(entry.sub)}</li>`
          })
          .join('')}</ul>`

  return parts
    .map((part) => {
      if (part.type === 'list') return bullets(part.entries)
      if (part.type === 'label') return `<p><strong>${escapeHtml(part.text)}</strong></p>`
      return `<${part.type}>${escapeHtml(part.text)}</${part.type}>`
    })
    .join('')
}
