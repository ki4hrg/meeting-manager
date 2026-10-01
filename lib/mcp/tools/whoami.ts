import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '../../db/schema'
import { defineTool, ToolRefusal } from './types'

/** Proves the authenticated path end to end; the domain tools arrive in phase 1. */
export const whoamiTool = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description: 'The account this connection acts as, and the scopes it was granted.',
  scope: 'meetings:read',
  input: z.object({}),
  annotations: { readOnlyHint: true },
  handler: async (_input, { exec, identity }) => {
    const [user] = await exec
      .select({ email: users.email, name: users.displayName, time_zone: users.timeZone })
      .from(users)
      .where(eq(users.id, identity.userId))
      .limit(1)
    if (!user) throw new ToolRefusal('That account no longer exists.')

    return { ...user, client: identity.clientName, scopes: identity.scopes }
  },
})
