import { CardGrid, Section } from '@/components/ui/Card'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { getMeeting } from '@/lib/meetings/meetings'
import { MeetingCard } from './MeetingCard'

/**
 * The meetings with proposals waiting: the next thing to do, so it sits above
 * both the upcoming and the past list while it has anything. Sessions and
 * long-past meetings are read one by one, since no list is sure to hold them.
 */
export async function ReviewSection({
  pending,
  timeZone,
}: {
  pending: Map<string, number>
  timeZone: string | null
}) {
  const toReview = (await Promise.all([...pending.keys()].map((id) => getMeeting(db, id)))).sort(
    (a, b) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0),
  )
  if (toReview.length === 0) return null
  return (
    <Section title="Review" count={toReview.length}>
      <CardGrid>
        {toReview.map((meeting) => (
          <MeetingCard
            key={meeting.id}
            meeting={meeting}
            when={meeting.startsAt ? formatMoment(meeting.startsAt, timeZone) : null}
            pending={pending.get(meeting.id)}
            to="review"
          />
        ))}
      </CardGrid>
    </Section>
  )
}
