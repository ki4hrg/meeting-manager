import { ItemGrid } from '@/components/items/ItemCard'
import { UnfiledCard } from '@/components/meetings/UnfiledCard'
import { QuickAdd } from '@/components/QuickAdd'
import { CardGrid, Section } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { listUnfiledNotes } from '@/lib/connect/granola/unfiled'
import { db } from '@/lib/db'
import { listItems } from '@/lib/items/items'
import { allContexts, requireContext, viewer } from '@/lib/web/context'

/*
 * What has nowhere to go yet: this context's items with no party, project or
 * target, and the meetings Granola recorded that no folder filed. Those belong
 * to no context, so they are here whichever one is selected.
 */
export default async function InboxPage() {
  const context = await requireContext()
  const { user, today } = await viewer()
  const [items, notes, contexts] = await Promise.all([
    listItems(db, { contextId: context.id, inbox: true }),
    listUnfiledNotes(db),
    allContexts(),
  ])

  return (
    <>
      <PageHeader title="Inbox" count={items.length + notes.length} actions={<QuickAdd />} />
      {notes.length > 0 ? (
        <Section title="Meetings" count={notes.length}>
          <CardGrid>
            {notes.map((note) => (
              <UnfiledCard
                key={note.id}
                note={note}
                contexts={contexts}
                current={context.id}
                timeZone={user.timeZone}
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}
      {notes.length > 0 ? (
        <Section title="Items" count={items.length}>
          <ItemGrid items={items} today={today} empty="inbox" />
        </Section>
      ) : (
        <ItemGrid items={items} today={today} empty="inbox" />
      )}
    </>
  )
}
