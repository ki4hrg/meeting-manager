import { Section } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { KIND } from '@/components/ui/StatusBadge'
import type { ItemKind, ItemView } from '@/lib/items/items'
import { ItemGrid } from './ItemCard'

type OwnerGroup = { key: string; name: string; group: boolean; items: ItemView[] }

/* Items under each party that owes them. An item with several owners appears
   under each; one with none is gathered at the end. */
function byOwner(items: ItemView[]): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>()
  const unowned: ItemView[] = []

  for (const item of items) {
    const owners = item.parties.filter((party) => party.role === 'owner')
    if (owners.length === 0) unowned.push(item)
    for (const owner of owners) {
      const entry = groups.get(owner.id) ?? {
        key: owner.id,
        name: owner.isSelf ? 'Me' : owner.name,
        group: owner.type === 'group',
        items: [],
      }
      entry.items.push(item)
      groups.set(owner.id, entry)
    }
  }

  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (unowned.length > 0) sorted.push({ key: 'none', name: '—', group: false, items: unowned })
  return sorted
}

/**
 * A hub's items of one kind under the kind's name, mark and colour. Questions
 * and action items are grouped under who owes them.
 */
export function KindSection({
  kind,
  items,
  today,
  action,
  showProject,
}: {
  kind: ItemKind
  items: ItemView[]
  today: string
  action?: React.ReactNode
  showProject?: boolean
}) {
  const { plural, icon, tone } = KIND[kind]
  const owed = kind === 'question' || kind === 'action'
  return (
    <Section title={plural} icon={icon} tone={tone} count={items.length} action={action}>
      {items.length === 0 ? null : owed ? (
        <div className="flex flex-col gap-5">
          {byOwner(items).map((owner) => (
            <div key={owner.key}>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
                <Icon name={owner.group ? 'group' : 'person'} className="h-4 w-4" />
                {owner.name}
              </h3>
              <ItemGrid items={owner.items} today={today} empty={icon} showProject={showProject} />
            </div>
          ))}
        </div>
      ) : (
        <ItemGrid items={items} today={today} empty={icon} showProject={showProject} />
      )}
    </Section>
  )
}
