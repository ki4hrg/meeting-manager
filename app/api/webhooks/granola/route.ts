/*
 * POST /api/webhooks/granola — where Granola says a note is ready or changed.
 *
 * No session and no token: this is a URL Granola posts to, and the signature
 * on the delivery is the only authentication (lib/connect/granola/webhook.ts,
 * which also does everything else). The body is read as text, once, because
 * the signature covers the bytes as they arrived.
 *
 * Processing never happens inside this response: a filed note queues a run and
 * the job is kicked, not awaited.
 */

import { receiveDelivery } from '@/lib/connect/granola/webhook'
import { db } from '@/lib/db'
import { kick, PROCESS_NOTES } from '@/lib/jobs'

export const runtime = 'nodejs'
/* Nothing here is cacheable, and a cached 200 would swallow deliveries. */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const result = await receiveDelivery(db, {
    headers: request.headers,
    body: await request.text(),
  })

  // `kick` never rejects for a failed run; the job's own timer is the fallback.
  if (result.queued) void kick(PROCESS_NOTES)

  return Response.json(result.body, { status: result.status })
}
