import type { IconName } from '@/components/ui/icons'
import type { ItemKind, ItemParty } from '@/lib/items/items'
import { COLLABORATOR, hasCollaborators, roleLabel, roleMoves, roleOrder, type PartyRole } from '@/lib/items/roles'
import type { ActionResult } from '@/lib/web/action'
import { PartyChip } from './PartyChip'

type Action = (formData: FormData) => Promise<ActionResult>

type Row = { label: string; role: PartyRole; offset: number; marks: IconName[]; parties: ItemParty[] }

/**
 * An item's parties under their roles in words, in the order the kind reads
 * them (`lib/items/roles.ts`): who leads, collaborators, then who the arrow
 * points at. Each chip can be moved to another role or removed. `children`
 * (the add button) ends the last row.
 */
export function PartyRoles({
  itemId,
  kind,
  parties,
  move,
  remove,
  children,
}: {
  itemId: string
  kind: ItemKind
  parties: ItemParty[]
  move: Action
  remove: Action
  children?: React.ReactNode
}) {
  const target = roleOrder(kind)[1]
  const owners = parties.filter((party) => party.role === 'owner').length
  const rows: Row[] = roleOrder(kind).flatMap((role): Row[] => {
    const list = parties.filter((party) => party.role === role)
    const marks: IconName[] = role === target ? ['arrowRight'] : []
    if (role === 'owner' && hasCollaborators(kind)) {
      return [
        { label: roleLabel(kind, role), role, offset: 0, marks, parties: list.slice(0, 1) },
        { label: COLLABORATOR, role, offset: 1, marks: ['mutual'], parties: list.slice(1) },
      ]
    }
    return [{ label: roleLabel(kind, role), role, offset: 0, marks, parties: list }]
  })
  const shown = rows.filter((row) => row.parties.length > 0)

  const moveIcon = (role: PartyRole, lead: boolean | undefined, party: ItemParty): IconName =>
    role === target ? 'arrowRight' : lead === false ? 'mutual' : party.type

  if (shown.length === 0) return <div className="flex flex-wrap items-center gap-2">{children}</div>

  return (
    <div className="flex flex-col gap-2">
      {shown.map((row, rowIndex) => (
        <div key={row.label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-xs font-medium text-gray-500 sm:w-36 dark:text-gray-400">{row.label}</span>
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
            {rowIndex === shown.length - 1 ? children : null}
          </div>
        </div>
      ))}
    </div>
  )
}
