import { ActionSelect } from '@/components/ActionSelect'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { setTimeZoneAction } from './actions'

/* Choosing a zone saves it. Until one is saved the instance's own zone is
   shown, and the browser's is saved on the first page opened (`KeepTimeZone`). */
export function TimeZonePicker({
  saved,
  fallback,
  zones,
}: {
  saved: string | null
  /** The instance's own zone, used while nothing is saved. */
  fallback: string
  zones: string[]
}) {
  const value = saved ?? fallback
  const all = new Set([...zones, value])
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icon name="clock" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
        <ActionSelect
          key={value}
          action={setTimeZoneAction}
          fields={{}}
          name="timeZone"
          value={value}
          label="Time zone"
          className="min-w-0 flex-1"
        >
          {[...all].sort().map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </ActionSelect>
      </div>
    </Card>
  )
}
