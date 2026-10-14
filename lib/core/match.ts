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

/**
 * The same, over kinds of thing taken in order of precedence (quick-add's
 * `@`: people and groups, then projects, then series). An exact name of any
 * kind wins over a prefix of any; otherwise the first kind with a match
 * answers, so `@sarah` is Sarah Jones even with a "Sarah/John Check-In".
 */
export function matchTiered<T extends { name: string }>(tiers: T[][], token: string): T[] {
  const wanted = normalise(token)
  if (wanted === '') return []
  for (const tier of tiers) {
    const exact = tier.filter((candidate) => normalise(candidate.name) === wanted)
    if (exact.length > 0) return exact
  }
  for (const tier of tiers) {
    const matches = matchName(tier, token)
    if (matches.length > 0) return matches
  }
  return []
}

/** The token that names something unambiguously: "Sarah Jones" becomes "Sarah-Jones". */
export function tokenFor(name: string): string {
  return name
    .normalize('NFKD')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join('-')
}

/** The name a token stands for: `Neil-Campbell` is "Neil Campbell". */
export function nameFromToken(token: string): string {
  return token.replace(/[-_]+/g, ' ').trim()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}
