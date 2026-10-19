import { Icon, type IconName } from '@/components/ui/icons'
import type { Stance } from '@/lib/items/roles'

/* The same marks as a party line: the arrow points at who it is for, the
   two-way mark is working on it together. */
const STANCE: Record<Stance, { icon: IconName; label: string; flip?: boolean }> = {
  theirs: { icon: 'arrowRight', label: 'To me', flip: true },
  mine: { icon: 'arrowRight', label: 'From me' },
  elsewhere: { icon: 'undo', label: 'Reporting back' },
  together: { icon: 'mutual', label: 'Together' },
}

/** A muted sub-header naming where a run of items stands between John and someone (`stanceOf`). */
export function StanceLabel({ stance, children }: { stance: Stance; children?: React.ReactNode }) {
  const { icon, label, flip } = STANCE[stance]
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-gray-400 dark:text-gray-500">
      <Icon name={icon} className={`h-3.5 w-3.5 shrink-0 ${flip ? 'rotate-180' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </div>
  )
}
