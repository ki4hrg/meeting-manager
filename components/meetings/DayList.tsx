import { CardGrid } from '@/components/ui/Card'
import { formatTime, formatWeekday, todayIn } from '@/lib/core/dates'
import type { UpcomingEntry } from '@/lib/meetings/prep'
import { EventCard } from './EventCard'
import { MeetingCard } from './MeetingCard'

/** Meetings and calendar events grouped by day in the user's zone, in the order given. */
export function DayList({
  entries,
  today,
  timeZone,
  pending,
  agendas,
}: {
  entries: UpcomingEntry[]
  today: string
  timeZone: string | null
  pending: Map<string, number>
  /** Rows on each meeting's agenda, to mark which are prepped. */
  agendas?: Map<string, number>
}) {
  const days = new Map<string, UpcomingEntry[]>()
  for (const entry of entries) {
    const day = todayIn(timeZone, entry.startsAt)
    days.set(day, [...(days.get(day) ?? []), entry])
  }
  return (
    <div className="flex flex-col gap-5">
      {[...days].map(([day, dayEntries]) => (
        <div key={day}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
            {formatWeekday(day, today)}
            {day === today ? (
              <span className="h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-400" aria-label="Today" />
            ) : null}
          </h3>
          <CardGrid>
            {dayEntries.map((entry) => {
              const time = formatTime(entry.startsAt, timeZone)
              return entry.meeting ? (
                <MeetingCard
                  key={entry.meeting.id}
                  meeting={{ ...entry.meeting, series: entry.series }}
                  when={time}
                  pending={pending.get(entry.meeting.id)}
                  agenda={agendas ? (agendas.get(entry.meeting.id) ?? 0) : undefined}
                />
              ) : (
                <EventCard key={entry.event!.eventId} entry={entry} time={time} />
              )
            })}
          </CardGrid>
        </div>
      ))}
    </div>
  )
}
