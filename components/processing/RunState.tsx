import { reprocessAction } from '@/app/(app)/meetings/processing-actions'
import { ActionButton, IconAction } from '@/components/forms'
import { Icon } from '@/components/ui/icons'
import { Spinner } from '@/components/ui/Spinner'
import { Badge } from '@/components/ui/StatusBadge'
import type { Run } from '@/lib/processing/run'
import { AutoRefresh } from './AutoRefresh'

/**
 * Where a meeting's processing stands. While it is queued or running the page
 * keeps asking; a failure says why and offers the retry; a finished run leaves
 * a quiet way to run it again.
 */
export function RunState({ run, meetingId }: { run: Run | null; meetingId: string }) {
  if (!run) return null

  if (run.status === 'queued' || run.status === 'running') {
    return (
      <>
        <AutoRefresh />
        {run.status === 'queued' ? (
          <Badge tone="gray">
            <Icon name="clock" className="h-3 w-3" />
            Queued
          </Badge>
        ) : (
          <Badge tone="blue">
            <Spinner className="!h-3 !w-3" />
            Running
          </Badge>
        )}
      </>
    )
  }

  if (run.status === 'failed') {
    return (
      <>
        <Badge tone="red">
          <Icon name="alert" className="h-3 w-3" />
          Failed
        </Badge>
        <ActionButton action={reprocessAction} fields={{ meetingId }} variant="secondary" size="sm">
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Retry
        </ActionButton>
        {run.error ? (
          <p role="alert" className="error-message basis-full">
            {run.error}
          </p>
        ) : null}
      </>
    )
  }

  return (
    <>
      <Badge tone="green">
        <Icon name="check" className="h-3 w-3" />
        Processed
      </Badge>
      <IconAction action={reprocessAction} fields={{ meetingId }} icon="refresh" label="Process again" />
    </>
  )
}
