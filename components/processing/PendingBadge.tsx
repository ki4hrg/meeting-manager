import { Icon } from '@/components/ui/icons'
import { Badge } from '@/components/ui/StatusBadge'

/** How many proposals of a meeting are waiting to be reviewed. Nothing when none are. */
export function PendingBadge({ count }: { count: number | undefined }) {
  if (!count) return null
  return (
    <Badge tone="amber">
      <Icon name="clipboard" className="h-3 w-3" label="To review" />
      <span className="tabular-nums">{count}</span>
    </Badge>
  )
}
