/* Links to a Granola note: built from its id, and taken out of text that
   carries one, so the note opens from a button rather than a bare URL. */

const HOST = 'https://notes.granola.ai'

/** The note in Granola's web app. */
export function granolaNoteUrl(id: string): string {
  return `${HOST}/d/${encodeURIComponent(id)}`
}

const URL_PART = String.raw`https?://notes\.granola\.ai/d/([A-Za-z0-9_-]+)[^\s)>\]]*`

/* A Markdown link to a note, an autolink, or the bare URL, with a "Granola:"
   label in front of it if there is one. */
const LINK = new RegExp(
  String.raw`(?:\bGranola(?: note)?\s*[:\-–—]\s*)?(?:\[[^\]]*\]\(${URL_PART}\)|<${URL_PART}>|${URL_PART})`,
  'gi',
)

/**
 * The text without its Granola note links, and the ids of the notes they
 * pointed at, in order and once each. Whatever a link leaves behind (a blank
 * line, a space before a full stop) is tidied away.
 */
export function splitGranolaLinks(text: string): { text: string; ids: string[] } {
  const ids: string[] = []
  const stripped = text.replace(LINK, (_match, ...groups: unknown[]) => {
    const id = groups.slice(0, 3).find((group): group is string => typeof group === 'string')
    if (id && !ids.includes(id)) ids.push(id)
    return ''
  })
  if (ids.length === 0) return { text, ids }
  const tidy = stripped
    .split('\n')
    .map((line) => line.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: tidy, ids }
}
