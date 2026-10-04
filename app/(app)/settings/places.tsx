import { scopeOf, type Binding, type BindingScope } from '@/lib/connect/connections'
import { db } from '@/lib/db'
import type { Context } from '@/lib/directory/contexts'
import { listGroups } from '@/lib/directory/groups'
import { listSeries } from '@/lib/meetings/series'
import { listProjects } from '@/lib/projects/projects'

/* Where a calendar or a folder feeds: a context, or one project, series or
   group in it. The value is `<context>` or `<context>:<kind>:<id>`. */
export type Place = { value: string; label: string }
export type PlaceGroup = { label: string; places: Place[] }

const KINDS = ['project', 'series', 'group'] as const

export function placeOf(binding: Binding): string {
  const scope = scopeOf(binding)
  return scope ? `${binding.contextId}:${scope.kind}:${scope.id}` : binding.contextId
}

/** The context and scope a picked value names; an empty value names nothing. */
export function parsePlace(value: string): { contextId: string; scope: BindingScope } | null {
  const [contextId, kind, id] = value.split(':')
  if (!contextId) return null
  const known = KINDS.find((one) => one === kind)
  return { contextId, scope: known && id ? { kind: known, id } : null }
}

/* Each context, then its projects, series and groups. What is finished or
   archived is offered only while something still feeds it. */
export async function placesFor(contexts: Context[], bindings: Binding[]): Promise<PlaceGroup[]> {
  const bound = new Set(bindings.flatMap((binding) => scopeOf(binding)?.id ?? []))
  const keep = (one: { id: string; archivedAt: Date | null }) => !one.archivedAt || bound.has(one.id)

  return Promise.all(
    contexts.map(async (context) => {
      const [projects, series, groups] = await Promise.all([
        listProjects(db, context.id, 'all'),
        listSeries(db, context.id, 'all'),
        listGroups(db, context.id, 'all'),
      ])
      const under = (kind: (typeof KINDS)[number], rows: { id: string; name: string }[]) =>
        rows.map((row) => ({
          value: `${context.id}:${kind}:${row.id}`,
          label: `${context.name} › ${row.name}`,
        }))
      return {
        label: context.name,
        places: [
          { value: context.id, label: context.name },
          ...under(
            'project',
            projects.filter((one) => keep(one) && (one.status !== 'done' || bound.has(one.id))),
          ),
          ...under('series', series.filter(keep)),
          ...under('group', groups.filter(keep)),
        ],
      }
    }),
  )
}

export function placeLabel(groups: PlaceGroup[], value: string): string | null {
  for (const group of groups) {
    const place = group.places.find((one) => one.value === value)
    if (place) return place.label
  }
  return null
}

/** The options of a place picker, one group per context. */
export function PlaceOptions({ groups }: { groups: PlaceGroup[] }) {
  return groups.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.places.map((place) => (
        <option key={place.value} value={place.value}>
          {place.label}
        </option>
      ))}
    </optgroup>
  ))
}
