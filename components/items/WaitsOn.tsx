import Link from 'next/link'
import { Icon } from '@/components/ui/icons'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { KindIcon } from '@/components/ui/StatusBadge'
import type { ItemView } from '@/lib/items/items'
import type { ActionResult } from '@/lib/web/action'
import { PartyLine } from './ItemCard'

/**
 * On an item parked until another is done: back when that one is done (and on
 * the day, if one is set), with the cross that brings it back now.
 */
export function BackWhen({
  item,
  on,
  remove,
}: {
  item: { id: string; text: string }
  /** The day it comes back regardless, as shown. */
  on?: string | null
  remove: { action: (formData: FormData) => Promise<ActionResult>; fields: Record<string, string>; label: string }
}) {
  return (
    <RemovableChip icon="waitsOn" iconLabel="Waits on" href={`/items/${item.id}`} remove={remove}>
      <span className="font-normal text-gray-500 dark:text-gray-400">Back when</span> {item.text}{' '}
      <span className="font-normal text-gray-500 dark:text-gray-400">is done</span>
      {on ? ` · ${on}` : null}
    </RemovableChip>
  )
}

/** On an item others are parked behind: the ones that come back when it is done. */
export function WaitingOnThis({
  items,
}: {
  items: Pick<ItemView, 'id' | 'text' | 'kind' | 'ongoing' | 'parties'>[]
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Icon name="holdsUp" className="h-3.5 w-3.5 shrink-0" />
        Waiting on this
        <span className="tabular-nums">{items.length}</span>
      </span>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/items/${item.id}`}
              className="flex min-w-0 items-center gap-2 rounded-md border border-gray-200 px-3 py-1.5 text-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:hover:bg-gray-700/50"
            >
              <KindIcon kind={item.kind} ongoing={item.ongoing} className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{item.text}</span>
              <span className="flex min-w-0 max-w-[45%] shrink-0 justify-end">
                <PartyLine parties={item.parties} kind={item.kind} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
