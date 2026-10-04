import {
  attachStubAction,
  prepEventAction,
  seriesFromEventAction,
} from '@/app/(app)/meetings/actions'
import { ActionButton, IconAction } from '@/components/forms'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { ContextBadge } from '@/components/ui/StatusBadge'
import type { UpcomingEntry } from '@/lib/meetings/prep'
import { Roster, SeriesMark, When } from './MeetingCard'

/* A calendar event nobody has prepped yet: one click makes its meeting, or
   gives a waiting stub its date instead. */
export function EventCard({
  entry,
  time,
  context,
}: {
  entry: UpcomingEntry
  time: string
  /** The event's context, where events from several are listed together: its
      actions then act there rather than in the selected one. */
  context?: { id: string; name: string }
}) {
  const event = entry.event!
  const where: Record<string, string> = context ? { contextId: context.id } : {}
  const people = event.attendees
    .filter((attendee) => attendee.personId && !attendee.declined)
    .map((attendee) => ({ name: attendee.name ?? attendee.email }))

  return (
    <Card>
      <div className="flex items-start gap-3">
        <When label={time} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{event.title}</p>
          <Roster people={people} />
          {context ? (
            <p className="mt-1 flex">
              <ContextBadge name={context.name} />
            </p>
          ) : null}
        </div>
        <SeriesMark series={entry.series} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {event.seriesId && !entry.series ? (
          <IconAction
            action={seriesFromEventAction}
            fields={{ ...where, eventId: event.eventId }}
            icon="refresh"
            label="Make a series"
          />
        ) : null}
        {entry.stubs.map((stub) => (
          <ActionButton
            key={stub.id}
            action={attachStubAction}
            fields={{ ...where, meetingId: stub.id, eventId: event.eventId, at: event.startsAt.toISOString() }}
            variant="secondary"
            size="sm"
            aria-label={`Attach ${stub.title}`}
          >
            <Icon name="link" className="h-3.5 w-3.5" />
            <span className="max-w-[10rem] truncate">{stub.title}</span>
          </ActionButton>
        ))}
        <ActionButton
          action={prepEventAction}
          fields={{ ...where, eventId: event.eventId, at: event.startsAt.toISOString() }}
          variant="secondary"
          size="sm"
        >
          <Icon name="meeting" className="h-4 w-4" />
          Prep
        </ActionButton>
      </div>
    </Card>
  )
}
