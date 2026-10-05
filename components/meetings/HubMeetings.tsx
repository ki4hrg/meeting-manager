import { ButtonLink } from '@/components/ui/Button'
import { CardGrid, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/icons'
import { agendaCounts } from '@/lib/agenda/lines'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { hubPast, hubUpcoming, type Hub } from '@/lib/meetings/hub'
import { pendingOnCards } from '@/lib/processing/proposals'
import { DayList } from './DayList'
import { MeetingCard } from './MeetingCard'

const STEP = 14
const FARTHEST = 180
const PAGE = 9

type Search = Record<string, string | string[] | undefined>

/** How far ahead (`days`) and how many back (`past`) a hub shows, from its query. */
export function hubReach(query: Search): { days: number; past: number } {
  const whole = (value: unknown, fallback: number, most: number) => {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 ? Math.min(n, most) : fallback
  }
  return { days: whole(query.days, STEP, FARTHEST), past: whole(query.past, PAGE, 500) }
}

/* The page's own query with one value changed, so "More" keeps everything else
   (a project's sub-project roll-up, how far back). */
function withParam(path: string, query: Search, name: string, value: number): string {
  const params = new URLSearchParams()
  for (const [key, one] of Object.entries(query)) {
    if (typeof one === 'string') params.set(key, one)
  }
  params.set(name, String(value))
  return `${path}?${params}`
}

/* Steps far enough ahead to take in `at`, the next thing More would show. */
function reachFor(at: Date): number {
  const away = (at.getTime() - Date.now()) / 86_400_000
  return Math.min((Math.floor(away / STEP) + 1) * STEP, FARTHEST)
}

/**
 * A hub's meetings: what is coming (its meetings and the calendar events that
 * would be its own, each with Prep), then what was held. More, when the
 * calendar holds more of its own, reaches further ahead; Earlier further back.
 */
export async function HubMeetings({
  hub,
  contextId,
  path,
  query,
  timeZone,
  today,
  skip,
}: {
  hub: Hub
  /** The hub's context: its events are read, and prepped, there. */
  contextId: string
  /** The hub page's own path, for More and Earlier. */
  path: string
  query: Search
  timeZone: string | null
  today: string
  /** A meeting shown elsewhere on the page (a series' Next), left out here. */
  skip?: string
}) {
  const { days, past } = hubReach(query)
  const [{ entries, later, stubs, further }, held, pending] = await Promise.all([
    hubUpcoming(db, contextId, hub, { days, reach: FARTHEST }),
    hubPast(db, contextId, hub, { limit: past }),
    pendingOnCards(db, contextId),
  ])
  const ahead = entries.filter((entry) => !skip || entry.meeting?.id !== skip)
  const agendas = await agendaCounts(
    db,
    ahead.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])),
  )
  const beyond = [...later, ...stubs].filter((meeting) => meeting.id !== skip)
  const count = ahead.length + beyond.length

  return (
    <>
      <Section title="Upcoming" count={count}>
        {count === 0 ? (
          <EmptyState icon="meeting" />
        ) : (
          <div className="flex flex-col gap-5">
            {ahead.length > 0 ? (
              <DayList
                entries={ahead}
                today={today}
                timeZone={timeZone}
                pending={pending}
                agendas={agendas}
                actIn={contextId}
              />
            ) : null}
            {beyond.length > 0 ? (
              <CardGrid>
                {beyond.map((meeting) => (
                  <MeetingCard
                    key={meeting.id}
                    meeting={meeting}
                    when={meeting.startsAt ? formatMoment(meeting.startsAt, timeZone) : null}
                    pending={pending.get(meeting.id)}
                  />
                ))}
              </CardGrid>
            ) : null}
          </div>
        )}
        {further ? (
          <div className="mt-4 flex justify-center">
            <ButtonLink href={withParam(path, query, 'days', reachFor(further))} scroll={false} variant="ghost">
              <Icon name="chevronDown" className="h-4 w-4" />
              More
            </ButtonLink>
          </div>
        ) : null}
      </Section>

      <Section title="Past" count={held.meetings.length}>
        {held.meetings.length === 0 ? (
          <EmptyState icon="clock" />
        ) : (
          <CardGrid>
            {held.meetings.map((meeting) => (
              <div key={meeting.id} className="opacity-70">
                <MeetingCard
                  meeting={meeting}
                  when={meeting.startsAt ? formatMoment(meeting.startsAt, timeZone) : null}
                  pending={pending.get(meeting.id)}
                />
              </div>
            ))}
          </CardGrid>
        )}
        {held.more ? (
          <div className="mt-4 flex justify-center">
            <ButtonLink href={withParam(path, query, 'past', past + PAGE)} scroll={false} variant="ghost">
              <Icon name="chevronDown" className="h-4 w-4" />
              Earlier
            </ButtonLink>
          </div>
        ) : null}
      </Section>
    </>
  )
}
