/** Title on the left, actions on the right; the actions drop below on a phone. */
export function PageHeader({
  title,
  count,
  actions,
}: {
  title: string
  count?: number
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <h1 className="flex items-baseline gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
        {title}
        {count !== undefined ? (
          <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">
            {count}
          </span>
        ) : null}
      </h1>
      {actions ? <div className="flex flex-col gap-2 sm:flex-row">{actions}</div> : null}
    </div>
  )
}
