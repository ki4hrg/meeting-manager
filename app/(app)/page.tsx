import { ItemGrid } from '@/components/items/ItemCard'
import { CardGrid, Section, Tile } from '@/components/ui/Card'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listItems, openCounts } from '@/lib/items/items'
import { listProjects } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'

export default async function HomePage() {
  const context = await requireContext()
  const { self, today } = await viewer()

  const counts = await openCounts(db, context.id)
  const projects = await listProjects(db, context.id)
  const groups = await listGroups(db, context.id)

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

      <Section title="I owe" count={mine.length}>
        <ItemGrid items={mine} today={today} empty="action" />
      </Section>

      <Section title="Waiting on" count={waiting.length}>
        <ItemGrid items={waiting} today={today} empty="clock" />
      </Section>
    </>
  )
}
