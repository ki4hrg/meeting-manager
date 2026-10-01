import { ItemGrid } from '@/components/items/ItemCard'
import { QuickAdd } from '@/components/QuickAdd'
import { PageHeader } from '@/components/ui/PageHeader'
import { db } from '@/lib/db'
import { listItems } from '@/lib/items/items'
import { requireContext, viewer } from '@/lib/web/context'

export default async function InboxPage() {
  const context = await requireContext()
  const { today } = await viewer()
  const items = await listItems(db, { contextId: context.id, inbox: true })

  return (
    <>
      <PageHeader title="Inbox" count={items.length} actions={<QuickAdd />} />
      <ItemGrid items={items} today={today} empty="inbox" />
    </>
  )
}
