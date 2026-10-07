import { CardGrid, LinkCard } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon, type IconName } from '@/components/ui/icons'
import { Badge, ContextBadge, DueBadge, KindIcon, StatusBadge } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import { isLater } from '@/lib/items/horizon'
import { isOpen, type ItemKind, type ItemParty, type ItemView } from '@/lib/items/items'
import { COLLABORATOR, hasCollaborators, roleLabel, roleOrder, type PartyRole } from '@/lib/items/roles'
import { switches } from '@/lib/web/open'

function names(parties: ItemParty[]): string {
  return parties.map((party) => (party.isSelf ? 'Me' : party.name)).join(', ')
}

const mark = (list: ItemParty[]): IconName =>
  list.length > 1 || list[0]?.type === 'group' ? 'group' : 'person'

/**
 * Who an item involves, without the words "owner" or "with". Whoever leads
 * comes first under a person or group icon, collaborators follow the two-way
 * mark, and the arrow points at who it is for: on a question, who it is asked
 * of; on a decision, who decides (`lib/items/roles.ts`). An owner that is only
 * a guess is marked on the owner itself.
 */
export function PartyLine({
  parties,
  kind = 'action',
  ownerGuessed = false,
}: {
  parties: ItemParty[]
  kind?: ItemKind
  ownerGuessed?: boolean
}) {
  if (parties.length === 0) return <span />
  const [lead, target] = roleOrder(kind)
  const of = (role: PartyRole) => parties.filter((party) => party.role === role)
  const leading = of(lead)
  const pointed = of(target)

  /* An action's or a topic's first owner leads and the rest are collaborators;
     anywhere else everyone in the role stands together. */
  const split = (list: ItemParty[]) =>
    lead === 'owner' && hasCollaborators(kind) ? [list.slice(0, 1), list.slice(1)] : [list, []]

  const run = (role: PartyRole, list: ItemParty[], first: React.ReactNode) => {
    const [main, together] = split(list)
    const body = (
      <>
        {first}
        <span className="truncate">{names(main!)}</span>
        {together!.length > 0 ? (
          <>
            <Icon name="mutual" className="h-3.5 w-3.5 shrink-0" label={COLLABORATOR} />
            <span className="truncate">{names(together!)}</span>
          </>
        ) : null}
      </>
    )
    if (role === 'owner' && ownerGuessed) {
      return (
        <span title={`${roleLabel(kind, 'owner')}: a guess`} className="flex min-w-0">
          <Badge tone="amber">
            {body}
            <span aria-hidden>?</span>
            <span className="sr-only">(a guess)</span>
          </Badge>
        </span>
      )
    }
    return body
  }

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      {leading.length > 0
        ? run(
            lead,
            leading,
            <Icon
              name={mark(split(leading)[0]!)}
              className="h-3.5 w-3.5 shrink-0"
              label={roleLabel(kind, lead)}
            />,
          )
        : null}
      {pointed.length > 0
        ? run(
            target,
            pointed,
            <Icon name="arrowRight" className="h-3.5 w-3.5 shrink-0" label={roleLabel(kind, target)} />,
          )
        : null}
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
            <PartyLine parties={item.parties} kind={item.kind} />
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
