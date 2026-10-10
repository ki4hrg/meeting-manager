/*
 * GET /api/health — container healthcheck. Unauthenticated, and reports only
 * whether the database answers; nothing else is exposed.
 */

import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  try {
    await db.execute(sql`select 1`)
    return NextResponse.json({ status: 'ok' })
  } catch (error) {
    console.error('Health check could not reach the database', error)
    return NextResponse.json({ status: 'degraded', checks: { database: 'error' } }, { status: 503 })
  }
}
