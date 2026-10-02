'use client'

import { useTransition } from 'react'
import { approveAllAction } from '@/app/(app)/meetings/processing-actions'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'

/**
 * Accept everything that needs no thought, and say what was left: the ones
 * marked unsure or still naming somebody unknown stay on the screen.
 */
export function ApproveAll({ meetingId, count }: { meetingId: string; count: number }) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  function run() {
    const data = new FormData()
    data.set('meetingId', meetingId)
    startTransition(async () => {
      const result = await approveAllAction(data)
      if (result.error) {
        toast.error(result.error)
        return
      }
      for (const message of result.refused ?? []) toast.error(message)
      const said = `${result.accepted ?? 0} accepted`
      if (result.left) toast.info(`${said} · ${result.left} left`)
      else toast.success(said)
    })
  }

  return (
    <Button onClick={run} disabled={pending || count === 0}>
      <Icon name="check" className="h-4 w-4" />
      Approve all
      <span className="tabular-nums opacity-80">{count}</span>
    </Button>
  )
}
