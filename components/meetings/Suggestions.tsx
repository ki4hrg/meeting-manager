import Link from 'next/link'
import { itemStatusAction, undropItemAction } from '@/app/(app)/actions'
import { placeItemAction, placeItemsAction, restoreCandidateAction } from '@/app/(app)/meetings/actions'
import { IconAction } from '@/components/forms'
import { StanceLabel } from '@/components/items/Stance'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { KindIcon } from '@/components/ui/StatusBadge'
import type { CandidateGroup, Candidates } from '@/lib/agenda/candidates'
import type { ItemView } from '@/lib/items/items'

const SUMMARY =
  'flex cursor-pointer list-none items-center gap-2 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden'

const count = (groups: CandidateGroup[]) => groups.reduce((sum, group) => sum + group.items.length, 0)

function ItemRow({ item, children }: { item: ItemView; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 py-1.5">
      <KindIcon kind={item.kind} ongoing={item.ongoing} className="mt-0.5 h-4 w-4" />
      <Link
        href={`/items/${item.id}`}
        className="min-w-0 flex-1 text-sm text-gray-900 hover:underline dark:text-gray-100"
      >
        {item.text}
      </Link>
      <div className="flex shrink-0 items-center">{children}</div>
    </li>
  )
}

function PlaceAll({ items, meetingId, label }: { items: ItemView[]; meetingId: string; label: string }) {
  return (
    <IconAction
      action={placeItemsAction}
      fields={{ meetingId, itemIds: items.map((item) => item.id).join(',') }}
      icon="plus"
      tone="blue"
      label={label}
    />
  )
}

function Rows({ items, meetingId }: { items: ItemView[]; meetingId: string }) {
  return (
    <ul>
      {items.map((item) => (
        <ItemRow key={item.id} item={item}>
          <IconAction
            action={placeItemAction}
            fields={{ meetingId, itemId: item.id }}
            icon="plus"
            label={`Place ${item.text}`}
          />
          <IconAction
            action={itemStatusAction}
            fields={{ id: item.id, op: 'drop' }}
            icon="close"
            label={`Drop ${item.text}`}
            done="Dropped"
            undo={{ action: undropItemAction, fields: { id: item.id } }}
          />
        </ItemRow>
      ))}
    </ul>
  )
}

/* Candidates under the person, group or project that brought them here; under
   a person or a group, by where each stands between John and them. */
function Groups({ groups, meetingId }: { groups: CandidateGroup[]; meetingId: string }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={`${group.by.type}:${group.by.id}`}>
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
            <Icon name={group.by.type} className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{group.by.name}</span>
            {group.items.length > 1 ? (
              <PlaceAll items={group.items} meetingId={meetingId} label={`Place all from ${group.by.name}`} />
            ) : null}
          </div>
          <div className="ml-1 flex flex-col gap-2 border-l-2 border-gray-100 pl-3 dark:border-gray-700">
            {group.bands ? (
              group.bands.map((band) => (
                <div key={band.stance} className="pt-1.5">
                  <StanceLabel stance={band.stance}>
                    {band.items.length > 1 && band.items.length < group.items.length ? (
                      <PlaceAll items={band.items} meetingId={meetingId} label={`Place these ${band.items.length}`} />
                    ) : null}
                  </StanceLabel>
                  <Rows items={band.items} meetingId={meetingId} />
                </div>
              ))
            ) : (
              <Rows items={group.items} meetingId={meetingId} />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * What could go on this agenda, closed until asked for: the suggestions, one
 * click each to place or drop (left alone, one waits here for the next
 * meeting); under them the person-only items of a larger meeting, and what was
 * aimed here but taken off the agenda, which can come back.
 */
export function Suggestions({ candidates, meetingId }: { candidates: Candidates; meetingId: string }) {
  const suggested = count(candidates.suggested)
  const more = count(candidates.more)
  const dismissed = candidates.dismissed.length
  if (suggested + more + dismissed === 0) return null

  return (
    <details className="group mb-8">
      <summary className={`${SUMMARY} mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100`}>
        <Icon name="sparkles" className="h-5 w-5 text-gray-400 dark:text-gray-500" />
        Suggestions
        <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">{suggested}</span>
        <Icon
          name="chevronDown"
          className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-500"
        />
      </summary>

      <Card>
        <div className="flex flex-col gap-4">
          {suggested > 0 ? <Groups groups={candidates.suggested} meetingId={meetingId} /> : null}

          {more > 0 ? (
            <details>
              <summary className={`${SUMMARY} text-sm font-medium text-gray-500 dark:text-gray-400`}>
                <Icon name="chevronDown" className="h-4 w-4" />
                More
                <span className="tabular-nums">{more}</span>
              </summary>
              <div className="mt-3">
                <Groups groups={candidates.more} meetingId={meetingId} />
              </div>
            </details>
          ) : null}

          {dismissed > 0 ? (
            <details>
              <summary className={`${SUMMARY} text-sm font-medium text-gray-500 dark:text-gray-400`}>
                <Icon name="chevronDown" className="h-4 w-4" />
                Dismissed
                <span className="tabular-nums">{dismissed}</span>
              </summary>
              <ul className="mt-2">
                {candidates.dismissed.map((item) => (
                  <ItemRow key={item.id} item={item}>
                    <IconAction
                      action={restoreCandidateAction}
                      fields={{ meetingId, itemId: item.id }}
                      icon="undo"
                      label={`Restore ${item.text}`}
                    />
                  </ItemRow>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </Card>
    </details>
  )
}
