import Link from 'next/link'
import { Badge } from '@/components/ui/StatusBadge'
import type { Agenda } from '@/lib/agenda/lines'
import { formatSpan } from '@/lib/core/dates'
import { AgendaCard, type LeaderChoice, type SessionChoice } from './AgendaCard'

/** One session of a multi-day meeting, as it sits in the meeting's agenda: its name, when, and its own agenda. */
export function SessionAgenda({
  session,
  agenda,
  today,
  timeZone,
  people,
  sessions,
  tools,
  housekeeping,
}: {
  session: { id: string; title: string; startsAt: Date | null; endsAt: Date | null }
  agenda: Agenda
  today: string
  timeZone: string | null
  people: LeaderChoice[]
  sessions?: SessionChoice[]
  tools?: React.ReactNode
  /** Icon-only actions on the session itself, beside its name. */
  housekeeping?: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            href={`/meetings/${session.id}`}
            className="min-w-0 truncate text-base font-semibold text-gray-900 hover:underline dark:text-gray-100"
          >
            {session.title}
          </Link>
          {session.startsAt ? (
            <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400">
              {formatSpan(session.startsAt, session.endsAt, timeZone, today)}
            </span>
          ) : (
            <Badge tone="amber">Undated</Badge>
          )}
          {housekeeping ? <span className="flex items-center self-center">{housekeeping}</span> : null}
        </div>
        {tools}
      </div>
      <AgendaCard agenda={agenda} today={today} people={people} sessions={sessions} />
    </div>
  )
}
