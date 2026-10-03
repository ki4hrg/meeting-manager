/*
 * The seam between the processing pipeline and the model.
 *
 * `run.ts` builds an ExtractionInput from the database and stores what comes
 * back as proposals; an Extractor turns one into the other and touches nothing.
 * Tests pass a fake Extractor, so no test calls a model.
 */

import type { ProposalPayload } from '../db/schema'

export type ItemKindName = 'topic' | 'question' | 'action' | 'decision'

/** A `D:` `Q:` `A:` `T:` line from John's own notes, exactly as he wrote it. */
export type VerbatimLine = {
  kind: ItemKindName
  /** The line without its prefix, `@mentions` and `#projects` still in place. */
  text: string
}

export type ExtractionInput = {
  meeting: {
    id: string
    title: string
    /** In the user's time zone, e.g. "2026-10-01 14:00"; null for an undated meeting. */
    startsAt: string | null
    /** Everyone there but John. */
    people: { id: string; name: string }[]
    groups: { id: string; name: string }[]
    projects: { id: string; name: string }[]
  }
  /** John, so "I'll send it" resolves to an owner. */
  self: { id: string; name: string }
  /** The day the meeting happened (or today), in the user's time zone: what "by Friday" counts from. */
  today: string
  note: {
    /** John's own words: the scratchpad or the pasted text. */
    body: string
    summary: string | null
    transcript: string | null
  }
  agenda: { lineId: string; section: string | null; text: string; itemId: string | null }[]
  /** Open items of the meeting's context that involve its people, groups or projects. */
  openItems: {
    id: string
    kind: ItemKindName
    text: string
    detail: string | null
    owners: string[]
    with: string[]
    project: string | null
    dueOn: string | null
  }[]
  /** Who and what a name in the notes can resolve to. People are global; groups and projects are the context's. */
  directory: {
    people: { id: string; name: string }[]
    groups: { id: string; name: string }[]
    projects: { id: string; name: string }[]
  }
  /** Already captured, not to be proposed again: the verbatim lines, in order, and
      items quick-added during the meeting. */
  verbatim: VerbatimLine[]
  captured: { kind: ItemKindName; text: string }[]
  /** Text of proposals already made or turned away for this meeting, so an edited
      note proposes only what is new. */
  handled: string[]
}

export type ExtractionDraft = {
  payload: ProposalPayload
  /** The owner was a guess. */
  lowConfidence: boolean
  agendaLineId: string | null
}

export type ExtractionOutput = {
  summary: string | null
  lines: { lineId: string; summary: string }[]
  drafts: ExtractionDraft[]
  /** A best-effort summary of the discussion around each verbatim line, by its index in `verbatim`. */
  verbatimDetails: { index: number; detail: string }[]
}

export type Extractor = (input: ExtractionInput) => Promise<ExtractionOutput>
