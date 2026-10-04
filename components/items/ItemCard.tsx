import { CardGrid, LinkCard } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon, type IconName } from '@/components/ui/icons'
import { Badge, ContextBadge, DueBadge, KindIcon, StatusBadge } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import { isLater } from '@/lib/items/horizon'
import { isOpen, type ItemParty, type ItemView } from '@/lib/items/items'
import { switches } from '@/lib/web/open'

function names(parties: ItemParty[]): string {
  return parties.map((party) => (party.isSelf ? 'Me' : party.name)).join(', ')
}

/**
 * Who an item involves, without the words "owner" or "with": owners come
 * first under a person or group icon, and an arrow leads to who it is with.
 * An owner that is only a guess is marked on the owner itself.
 */
export function PartyLine({ parties, ownerGuessed = false }: { parties: ItemParty[]; ownerGuessed?: boolean }) {
  const owners = parties.filter((party) => party.role === 'owner')
  const withs = parties.filter((party) => party.role === 'with')
  if (parties.length === 0) return <span />

  const icon = (list: ItemParty[]): IconName =>
    list.length > 1 || list[0]?.type === 'group' ? 'group' : 'person'

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      {owners.length > 0 && ownerGuessed ? (
        <span title="Owner is a guess" className="flex min-w-0">
          <Badge tone="amber">
            <Icon name={icon(owners)} className="h-3 w-3 shrink-0" label="Owner" />
            <span className="truncate">{names(owners)}</span>
            <span aria-hidden>?</span>
            <span className="sr-only">(a guess)</span>
          </Badge>
        </span>
      ) : owners.length > 0 ? (
        <>
          <Icon name={icon(owners)} className="h-3.5 w-3.5 shrink-0" label="Owner" />
          <span className="truncate">{names(owners)}</span>
        </>
      ) : null}
      {withs.length > 0 ? (
        <>
          <Icon name="arrowRight" className="h-3.5 w-3.5 shrink-0" label="With" />
          <span className="truncate">{names(withs)}</span>
        </>
      ) : null}
    </span>
  )
}

export function ItemCard({
  item,
  today,
  showProject = true,
  href = `/items/${item.id}`,
  context,
}: {
  item: ItemView
  today: string
  /** Off on the project's own page, where it would only repeat the title. */
  showProject?: boolean
  /** Where it opens, when not its own page in the selected context (`openHref`). */
  href?: string
  /** Its context's name, where items from several are listed together. */
  context?: string
}) {
  const open = isOpen(item)

  return (
    <LinkCard href={href} plain={switches(href)}>
      <div className="flex items-start gap-3">
        <KindIcon kind={item.kind} />
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-medium ${
              item.status === 'dropped' || item.status === 'superseded'
                ? 'text-gray-500 line-through dark:text-gray-400'
                : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {item.text}
          </p>
          {/* The answer if there is one; otherwise the detail, which on a
              reported-back topic is the answer being carried. */}
          {(item.resolution ?? item.detail) ? (
            <p className="mt-1 line-clamp-2 text-sm text-gray-600 dark:text-gray-300">
              {item.resolution ?? item.detail}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <PartyLine parties={item.parties} />
            <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {context ? <ContextBadge name={context} /> : null}
              {showProject && item.project ? <Badge>{item.project.name}</Badge> : null}
              {item.dueOn ? (
                <DueBadge
                  label={formatDay(item.dueOn, today)}
                  dueOn={item.dueOn}
                  today={today}
                  open={open}
                />
              ) : null}
              {open && isLater(item, today) ? (
                <Badge>
                  <Icon name="later" className="h-3 w-3" label="Later" />
                  {item.laterOn ? formatDay(item.laterOn, today) : null}
                </Badge>
              ) : null}
              {item.status !== 'open' ? <StatusBadge status={item.status} /> : null}
            </span>
          </div>
        </div>
      </div>
    </LinkCard>
  )
}

/** A grid of items, or the icon that stands for none. */
export function ItemGrid({
  items,
  today,
  empty,
  showProject,
  href,
  context,
}: {
  items: ItemView[]
  today: string
  empty: IconName
  showProject?: boolean
  /** Where each opens, and its context's name, where items from several contexts are listed. */
  href?: (item: ItemView) => string
  context?: (item: ItemView) => string | undefined
}) {
  if (items.length === 0) return <EmptyState icon={empty} />
  return (
    <CardGrid>
      {items.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          today={today}
          showProject={showProject}
          href={href?.(item)}
          context={context?.(item)}
        />
      ))}
    </CardGrid>
  )
}
