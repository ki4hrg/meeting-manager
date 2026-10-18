/*
 * POST /api/webhooks/todoist — where Todoist says a task changed.
 *
 * No session and no token: the signature on the delivery is the only
 * authentication (lib/connect/todoist/webhook.ts). The body is read as text,
 * once, because the signature covers the bytes as they arrived. The sync is
 * kicked, not awaited.
 */

import { receiveTodoistDelivery } from '@/lib/connect/todoist/webhook'
import { db } from '@/lib/db'
import { kick, TODOIST_SYNC } from '@/lib/jobs'

export const runtime = 'nodejs'
/* Nothing here is cacheable, and a cached 200 would swallow deliveries. */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const result = await receiveTodoistDelivery(db, {
    headers: request.headers,
    body: await request.text(),
  })

  // `kick` never rejects for a failed run; the job's own timer is the fallback.
  if (result.sync) void kick(TODOIST_SYNC)

  return Response.json(result.body, { status: result.status })
}
