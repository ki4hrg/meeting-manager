import { Breadcrumbs, type Crumb } from './Breadcrumbs'

/**
 * Title on the left, actions on the right; the actions drop below on a phone.
 * `actions` are buttons with an icon and a label, at most one of them blue.
 * `tools` is the housekeeping (Edit, Move, Archive, Delete), icon only, last.
 */
export function PageHeader({
  title,
  count,
  actions,
  tools,
  crumbs,
}: {
  title: string
  /** The way back up; see `Breadcrumbs`. */
  crumbs?: Crumb[]
  count?: number
  actions?: React.ReactNode
  tools?: React.ReactNode
}) {
  const header = (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <h1 className="flex min-w-0 items-baseline gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
        {title}
        {count !== undefined ? (
          <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">
            {count}
          </span>
        ) : null}
      </h1>
      {actions || tools ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {tools ? <div className="flex items-center gap-0.5">{tools}</div> : null}
        </div>
      ) : null}
    </div>
  )
  if (!crumbs) return header
  return (
    <>
      <Breadcrumbs crumbs={crumbs} />
      {header}
    </>
  )
}
