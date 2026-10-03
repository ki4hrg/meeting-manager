/*
 * Matching a typed name against the directory.
 *
 * Shared by the server, which resolves `@bishop` and `#campaign` when an item
 * is captured, and the quick-add box, which suggests completions as they are
 * typed. Both must agree on what a token matches, so the rule lives here and
 * imports nothing server-side.
 */

export function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * Candidates a token could mean. An exact name wins outright; otherwise any
 * name that starts with the token, from its first word or any later one.
 * `sarah-jones`, `SarahJones` and `sarah` all reach "Sarah Jones", and
 * `check-in` reaches "Adlene/John Check-In".
 */
export function matchName<T extends { name: string }>(candidates: T[], token: string): T[] {
  const wanted = normalise(token)
  if (wanted === '') return []

  const exact = candidates.filter((candidate) => normalise(candidate.name) === wanted)
  if (exact.length > 0) return exact

  return candidates.filter((candidate) => {
    const words = wordsOf(candidate.name)
    return words.some((_, index) => words.slice(index).join('').startsWith(wanted))
  })
}

/** The token that names something unambiguously: "Sarah Jones" becomes "Sarah-Jones". */
export function tokenFor(name: string): string {
  return name
    .normalize('NFKD')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join('-')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}
