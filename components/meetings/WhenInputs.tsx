'use client'

import { useRef } from 'react'
import { Field, Input } from '@/components/ui/Field'

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const HOUR = 60 * 60_000

/* A `datetime-local` value as a number, on no zone at all: the arithmetic is on the wall clock. */
function wall(value: string): number | null {
  const match = LOCAL.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  return Date.UTC(year, month - 1, day, hour, minute)
}

const local = (at: number) => new Date(at).toISOString().slice(0, 16)

/**
 * When a meeting runs: a start and an end on the user's clock, which may be
 * days apart. Both empty is an undated stub. Moving the start carries the end
 * with it, keeping the length; a start with no end yet gets an hour.
 */
export function WhenInputs({ starts, ends }: { starts?: string; ends?: string }) {
  const startRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLInputElement>(null)
  const previous = useRef(starts ?? '')

  function moved() {
    const start = startRef.current
    const end = endRef.current
    if (!start || !end) return
    const from = wall(start.value)
    const before = wall(previous.current)
    const until = wall(end.value)
    previous.current = start.value
    if (from === null) return
    if (until === null) end.value = local(from + HOUR)
    else if (before !== null) end.value = local(from + Math.max(0, until - before))
    else if (until < from) end.value = local(from + HOUR)
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Starts">
        <Input ref={startRef} name="startsAt" type="datetime-local" defaultValue={starts ?? ''} onChange={moved} />
      </Field>
      <Field label="Ends">
        <Input ref={endRef} name="endsAt" type="datetime-local" defaultValue={ends ?? ''} />
      </Field>
    </div>
  )
}
