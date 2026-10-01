/*
 * What a tool is.
 *
 * Tools are data — name, scope, schema, handler — rather than registrations
 * scattered across a setup function. Two things fall out of that and both are
 * the point:
 *
 *   `tools/list` can be filtered by scope by filtering an array, and
 *   the dispatcher can re-check scope on the way in, in one place, for every
 *   tool that will ever exist.
 *
 * A handler returns plain data and throws nothing it expects. Errors travel back
 * as content: a model recovers from "no meeting
 * matches that id, call list_meetings" and cannot recover from a stack trace.
 */

import type { z } from 'zod'
import type { ActorContext, Executor } from '@/lib/core/types'
import type { Scope } from '../../oauth/config'
import type { BearerIdentity } from '../../oauth/grants'

export type ToolContext = {
  exec: Executor
  actor: ActorContext
  identity: BearerIdentity
}

/**
 * A refusal the model should read, rather than an exception the transport turns
 * into a protocol error. Thrown by handlers and caught by the dispatcher, which
 * is the only place that knows how to shape it.
 */
export class ToolRefusal extends Error {
  constructor(
    message: string,
    /** Optional follow-up: what to call instead, or which identifier to supply. */
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ToolRefusal'
  }
}

export type ToolDefinition<Schema extends z.ZodType = z.ZodType> = {
  name: string
  title: string
  description: string
  /** The scope required. Checked at list time for ergonomics and at call time for real. */
  scope: Scope
  input: Schema
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
  }
  handler: (input: z.infer<Schema>, context: ToolContext) => Promise<unknown>
}

/** Keeps `input` and `handler` inferring together at each definition site. */
export function defineTool<Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>,
): ToolDefinition<z.ZodType> {
  return definition as unknown as ToolDefinition<z.ZodType>
}
