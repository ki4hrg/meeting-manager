import {
  attachStubAction,
  prepEventAction,
  seriesFromEventAction,
} from '@/app/(app)/meetings/actions'
import { ActionButton, IconAction } from '@/components/forms'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import type { UpcomingEntry } from '@/lib/meetings/prep'
import { Roster, SeriesMark, When } from './MeetingCard'

/* A calendar event nobody has prepped yet: one click makes its meeting, or
   gives a waiting stub its date instead. */
export function EventCard({ entry, time }: { entry: UpcomingEntry; time: string }) {
  const event = entry.event!
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
        </div>
        <SeriesMark series={entry.series} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {event.seriesId && !entry.series ? (
          <IconAction
            action={seriesFromEventAction}
            fields={{ eventId: event.eventId }}
            icon="refresh"
            label="Make a series"
          />
        ) : null}
        {entry.stubs.map((stub) => (
          <ActionButton
            key={stub.id}
            action={attachStubAction}
            fields={{ meetingId: stub.id, eventId: event.eventId, at: event.startsAt.toISOString() }}
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
          fields={{ eventId: event.eventId, at: event.startsAt.toISOString() }}
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
