/**
 * Pick any number from a short list: a labelled box of checkboxes that scrolls
 * once it is long. Each ticked option is submitted under `name`.
 */
export function CheckList({
  label,
  name,
  options,
  selected = [],
}: {
  label: string
  name: string
  options: Array<{ id: string; name: string }>
  selected?: string[]
}) {
  if (options.length === 0) return null

  return (
    <fieldset className="min-w-0">
      <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</legend>
      <div className="mt-1 max-h-44 overflow-y-auto rounded-md border border-gray-300 bg-white py-1 shadow-sm dark:border-gray-600 dark:bg-gray-700">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-600"
          >
            <input
              type="checkbox"
              name={name}
              value={option.id}
              defaultChecked={selected.includes(option.id)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500"
            />
            <span className="min-w-0 truncate">{option.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
