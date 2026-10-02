import { CardGrid, LinkCard } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PendingBadge } from '@/components/processing/PendingBadge'
import { Icon } from '@/components/ui/icons'
import { formatMoment } from '@/lib/core/dates'
import { isOver } from '@/lib/meetings/meetings'

type Listed = {
  id: string
  title: string
  startsAt: Date | null
  endsAt?: Date | null
  people: Array<{ name: string }>
  group?: { name: string } | null
  series?: { name: string } | null
}

/**
 * What a meeting card says under its title: who is coming, or the group whose
 * meeting it is. The icon says which.
 */
export function Roster({
  people,
  group,
}: {
  people: Array<{ name: string }>
  group?: { name: string } | null
}) {
  if (!group && people.length === 0) return null
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <Icon
        name={group || people.length > 1 ? 'group' : 'person'}
        className="h-3.5 w-3.5 shrink-0"
      />
      <span className="truncate">
        {group ? group.name : people.map((person) => person.name).join(', ')}
      </span>
    </p>
  )
}

/** The left of a meeting card: when it is, or the mark of one with no date yet. */
export function When({ label }: { label: string | null }) {
  if (!label) {
    return <Icon name="meeting" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" label="Undated" />
  }
  // "Oct 9, 3:40 PM" sits as the date over the time; a time alone is one line.
  const [first, ...rest] = label.split(', ')
  return (
    <span className="w-[4.5rem] shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-gray-900 dark:text-gray-100">
      <span className="block">{first}</span>
      {rest.length > 0 ? (
        <span className="block font-normal text-gray-500 dark:text-gray-400">{rest.join(', ')}</span>
      ) : null}
    </span>
  )
}

export function SeriesMark({ series }: { series?: { name: string } | null }) {
  if (!series) return null
  return (
    <span title={series.name} className="shrink-0 text-teal-600 dark:text-teal-400">
      <Icon name="refresh" className="h-4 w-4" label={`Series: ${series.name}`} />
    </span>
  )
}

/**
 * One meeting as a card. `when` is how its time reads in the list it sits in;
 * `pending` is how many proposals are waiting for review, and `to` sends the
 * card straight to that review instead of the meeting's page.
 */
export function MeetingCard({
  meeting,
  when,
  pending,
  to,
}: {
  meeting: Listed
  when: string | null
  pending?: number
  to?: 'review'
}) {
  return (
    <LinkCard href={to === 'review' ? `/meetings/${meeting.id}/review` : `/meetings/${meeting.id}`}>
      <div className="flex items-start gap-3">
        <When label={when} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {meeting.title}
          </p>
          <Roster people={meeting.people} group={meeting.group} />
        </div>
        <PendingBadge count={pending} />
        <SeriesMark series={meeting.series} />
      </div>
    </LinkCard>
  )
}

/**
 * The meetings of a person, group or project: what is coming (soonest first,
 * then the undated), then the most recent few.
 */
export function MeetingGrid({
  meetings,
  timeZone,
  pending,
  now = new Date(),
  recent = 3,
}: {
  meetings: Listed[]
  timeZone: string | null
  /** From `pendingByMeeting`: the meetings with proposals still to review. */
  pending?: Map<string, number>
  now?: Date
  recent?: number
}) {
  const over = (meeting: Listed) =>
    isOver({ startsAt: meeting.startsAt, endsAt: meeting.endsAt ?? null }, now)
  const ahead = meetings.filter((meeting) => !over(meeting))
  const behind = meetings
    .filter(over)
    .sort((a, b) => b.startsAt!.getTime() - a.startsAt!.getTime())
    .slice(0, recent)
  const shown = [
    ...ahead.filter((meeting) => meeting.startsAt).sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime()),
    ...ahead.filter((meeting) => !meeting.startsAt),
    ...behind,
  ]

  if (shown.length === 0) return <EmptyState icon="meeting" />
  return (
    <CardGrid>
      {shown.map((meeting) => (
        <div key={meeting.id} className={over(meeting) ? 'opacity-70' : ''}>
          <MeetingCard
            meeting={meeting}
            when={meeting.startsAt ? formatMoment(meeting.startsAt, timeZone) : null}
            pending={pending?.get(meeting.id)}
          />
        </div>
      ))}
    </CardGrid>
  )
}
