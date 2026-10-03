/*
 * What a proposal leaves unsaid that accepting it would want filled in: who
 * owns an action or a question, its project, and an action's deadline. The
 * review asks for these on Accept, in a short form that can be left blank.
 */

import type { ProposalPayload } from '../db/schema'

export type MissingDetail = 'owner' | 'project' | 'due'

export function missingDetails(
  payload: ProposalPayload,
  /** Whether the context has a project to pick. */
  projects: boolean,
): MissingDetail[] {
  const missing: MissingDetail[] = []
  if (payload.type === 'item') {
    const owed = payload.kind === 'action' || payload.kind === 'question'
    if (owed && !payload.parties.some((party) => party.role === 'owner')) missing.push('owner')
    if (projects && !payload.projectId) missing.push('project')
    if (payload.kind === 'action' && !payload.dueOn) missing.push('due')
  } else if (payload.type === 'document') {
    if (projects && !payload.projectId) missing.push('project')
  }
  return missing
}
