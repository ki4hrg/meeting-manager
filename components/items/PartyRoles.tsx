import type { IconName } from '@/components/ui/icons'
import type { ItemKind, ItemParty } from '@/lib/items/items'
import { COLLABORATOR, hasCollaborators, roleLabel, roleMoves, roleOrder, type PartyRole } from '@/lib/items/roles'
import type { ActionResult } from '@/lib/web/action'
import { targetMark } from './ItemCard'
import { PartyChip } from './PartyChip'

type Action = (formData: FormData) => Promise<ActionResult>

type Row = { label: string; role: PartyRole; offset: number; marks: IconName[]; parties: ItemParty[] }

/**
 * An item's parties under their roles in words, in the order the kind reads
 * them (`lib/items/roles.ts`): who leads, collaborators, then who the arrow
 * points at. Each chip can be moved to another role or removed. Every role
 * has its row, muted while empty, and `add` puts an add button at the end of
 * each row that takes one more: to that role, as its lead or a collaborator.
 */
export function PartyRoles({
  itemId,
  kind,
  parties,
  move,
  remove,
  add,
}: {
  itemId: string
  kind: ItemKind
  parties: ItemParty[]
  move: Action
  remove: Action
  add?: (row: { role: PartyRole; label: string }) => React.ReactNode
}) {
  const target = roleOrder(kind)[1]
  const owners = parties.filter((party) => party.role === 'owner').length
  const rows: Row[] = roleOrder(kind).flatMap((role): Row[] => {
    const list = parties.filter((party) => party.role === role)
    const marks: IconName[] = role === target ? [targetMark(kind)] : []
    if (role === 'owner' && hasCollaborators(kind)) {
      return [
        { label: roleLabel(kind, role), role, offset: 0, marks, parties: list.slice(0, 1) },
        { label: COLLABORATOR, role, offset: 1, marks: ['mutual'], parties: list.slice(1) },
      ]
    }
    return [{ label: roleLabel(kind, role), role, offset: 0, marks, parties: list }]
  })
  /* Collaborators join a lead, so their row waits for one; the lead row
     takes one person. */
  const shown = rows.filter((row) => row.parties.length > 0 || row.offset === 0 || owners > 0)
  const takesMore = (row: Row) => !(hasCollaborators(kind) && row.role === 'owner' && row.offset === 0 && owners > 0)

  const moveIcon = (role: PartyRole, lead: boolean | undefined, party: ItemParty): IconName =>
    role === target ? targetMark(kind) : lead === false ? 'mutual' : party.type

  return (
    <div className="flex flex-col gap-2">
      {shown.map((row) => (
        <div key={row.label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span
            className={`shrink-0 text-xs font-medium sm:w-36 ${
              row.parties.length > 0 ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'
            }`}
          >
            {row.label}
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {row.parties.map((party, index) => {
              const ref = `${party.type}:${party.id}`
              return (
                <PartyChip
                  key={party.id}
                  name={party.isSelf ? 'Me' : party.name}
                  href={party.type === 'group' ? `/groups/${party.id}` : `/people/${party.id}`}
                  icon={party.type}
                  marks={row.marks}
                  label={row.label}
                  moves={roleMoves(kind, party.role, row.offset + index, owners).map((one) => ({
                    label: one.label,
                    icon: moveIcon(one.role, one.lead, party),
                    fields: {
                      id: itemId,
                      party: ref,
                      role: one.role,
                      lead: one.lead === undefined ? '' : one.lead ? '1' : '0',
                    },
                  }))}
                  move={move}
                  remove={{ action: remove, fields: { id: itemId, party: ref } }}
                />
              )
            })}
            {add && takesMore(row) ? add({ role: row.role, label: row.label }) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
