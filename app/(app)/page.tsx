import { ItemGrid } from '@/components/items/ItemCard'
import { EventCard } from '@/components/meetings/EventCard'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { CardGrid, Section, Tile } from '@/components/ui/Card'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listItems, openCounts } from '@/lib/items/items'
import { listUpcoming } from '@/lib/meetings/prep'
import { listProjects } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'

export default async function HomePage() {
  const context = await requireContext()
  const { user, self, today } = await viewer()

  const counts = await openCounts(db, context.id)
  const projects = await listProjects(db, context.id)
  const groups = await listGroups(db, context.id)
  const next = (await listUpcoming(db, context.id)).entries.slice(0, 3)

  const mine = await listItems(db, {
    contextId: context.id,
    open: true,
    party: { personId: self.id, role: 'owner' },
  })
  // Owed by someone, and not by me: what I am waiting on.
  const waiting = (
    await listItems(db, { contextId: context.id, open: true, kinds: ['question', 'action'] })
  ).filter(
    (item) =>
      item.parties.some((party) => party.role === 'owner') &&
      !item.parties.some((party) => party.role === 'owner' && party.isSelf),
  )

  return (
    <>
      <div className="mb-8">
        <CardGrid>
          <Tile href="/meetings" icon="meeting" title="Meetings" tone="teal" />
          <Tile href="/inbox" icon="inbox" title="Inbox" tone="blue" count={counts.inbox} />
          <Tile
            href="/projects"
            icon="project"
            title="Projects"
            tone="purple"
            count={projects.filter((project) => project.status === 'active').length}
          />
          <Tile href="/people" icon="person" title="People" tone="green" />
          <Tile href="/groups" icon="group" title="Groups" tone="amber" count={groups.length} />
        </CardGrid>
      </div>

      {next.length > 0 ? (
        <Section title="Next up">
          <CardGrid>
            {next.map((entry) => {
              const when = formatMoment(entry.startsAt, user.timeZone)
              return entry.meeting ? (
                <MeetingCard
                  key={entry.meeting.id}
                  meeting={{ ...entry.meeting, series: entry.series }}
                  when={when}
                />
              ) : (
                <EventCard key={entry.event!.eventId} entry={entry} time={when} />
              )
            })}
          </CardGrid>
        </Section>
      ) : null}

      <Section title="I owe" count={mine.length}>
        <ItemGrid items={mine} today={today} empty="action" />
      </Section>

      <Section title="Waiting on" count={waiting.length}>
        <ItemGrid items={waiting} today={today} empty="clock" />
      </Section>
    </>
  )
}
