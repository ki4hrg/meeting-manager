# Meeting Manager: workflow and spec (greenfield successor to Meeter)

## Context

Meeter (`../Meeter`) does agenda building well but grew to ~82k lines, 49 tables, 110 MCP tools and a six-stop workflow per meeting. Its core problems are in the schema, not at the edges:

- Nothing can wait on a **person**; saving up questions for a sporadic meeting has no home.
- "Raise this next time" has four representations.
- Commitments, questions and decisions are three differently shaped tables, so one thing that changes type scatters its history, and each demands an owner and anchor up front.
- Todoist sync rewrites text, date and project on every run and reads back only completion (`lib/connect/todoist/sync.ts:449-473`).
- A Granola note only files itself on an exact calendar-event match, so drop-ins become manual "unfiled notes".
- Post-meeting processing is a ten-step Claude-driven skill.
- The UI is flat and undifferentiated.

Decisions made with John:

- **Greenfield, start empty.** Lift working code from Meeter; migrate no data.
- **Hybrid interface:** web UI plus Claude via MCP.
- **Granola is always the live screen.** The tool hands it a pasted brief and has no run view in the MVP.
- **Processing is automatic, then reviewed** on one screen.
- **Todoist:** two-way sync.
- **Keep** multi-day sessions, timed agendas, group ownership, project lookahead in agendas and recaps.
- **Post-MVP:** Google Doc publish and comment harvesting. **Dropped:** projector, multiple logins.
- John is the only user; everything outgoing is email or a Google Doc.

This version incorporates an independent review; its changes are marked *(review)*.

## Core model

### One item type, four kinds

A single `items` table. Only `context` and `text` are required.

| Kind | Meaning ("who has the ball?") | Closes when |
|---|---|---|
| `topic` | I want to raise, discuss or report this. Includes progress updates. | Discussed and finished |
| `question` | Something is unresolved and an answer is owed. "Needs a decision" is a question. | Answered (answer recorded) |
| `action` | A named party owes a deliverable. | Done or dropped |
| `decision` | Something was settled. A record, never "open". | Never; can be superseded |

- **Action vs question is decided by what closes it.** A question closes when information or a choice comes back. An action closes when a task is performed and there is nothing to report beyond "done". "These three need to meet to decide the lunch menu" is a question owned by the three. The extraction prompt applies this rule.
- **Topic, question and action convert in place**, keeping the record and history.
- **A decision is always its own record with its own wording** *(review)*. An answered question stays a question with its answer; "Record as decision" creates a linked decision pre-filled from the answer. This avoids a decision titled "What is the lunch menu?".
- **Spawning** links a child by `parent_item_id` (a decision spawns an action). The item page shows the whole thread.
- **Report back** *(review)*: when closing a question or recording a decision, an optional "report to" (person or group) spawns a child topic for that party carrying the resolution. This is how an answer from one meeting reaches another.
- **Fields:** `kind`, `status` (open, done, dropped; decisions: decided, superseded), `closed_at`, `superseded_by_item_id`, `text`, `detail`, `resolution`, `project_id`, `due_on` (always a deadline), `target_meeting_id` or `target_series_id`, `origin_meeting_id`, `parent_item_id`.
- **`item_parties`**: a person or a group, with role `owner` (owes the action/answer) or `with` (raise it with them; on an item John owns, the party it is owed to). Several allowed.
- **`item_events`** logs every step: created, discussed in meeting X, note added, converted, answered, completed, spawned. A topic discussed but unfinished stays open with a "discussed" event.
- Questions and actions share one shape and appear together in a single "owed" list per person, group and project.
- Items with no party, project or target sit in a per-context **Inbox**.

### People, groups, contexts

- **Contexts** are a hard boundary; projects, groups, meetings and items carry `context_id`.
- **People** are global, with `person_emails`; one person row is marked as John.
- **Groups** (`groups`, `group_members`) are context-scoped and act as parties alongside people. A meeting or series can belong to a group, which supplies its roster.
- **Capture context:** UI quick-add uses the selected context. MCP `capture_item` takes a context, or infers it from a named project or group.

### Agendas pull candidates; there are no anchors

*(review: bounded to stop flooding and leaks)*

**Placed automatically:**
- items targeting this meeting or its series;
- `with`-person items when the meeting has exactly two attendees (John and one other).

**Suggested** (collapsed list grouped by person, group and project; one click to place; "not this time" dismisses for this meeting):
- items whose project is one of the meeting's projects;
- items whose `with` or `owner` group is the meeting's group;
- items owned by an attendee, or `with` an attendee, that also carry one of the meeting's projects or groups.

**Not suggested:** person-only items in larger meetings (reachable under "more"), and anything matched only through John himself.

**Leak rule:** "Follow-ups due" and the recap draw only from items placed on the agenda or originating in this meeting, never from the raw candidate pull.

State lives in `agenda_lines` (placed) and `meeting_dismissals`.

The bishop case: capture "ask @bishop about X" over several weeks. The bishop's person page shows the batch. "Prep a meeting with…" creates an undated stub and places all of it.

### Meetings are light and created lazily

- Google Calendar is a read-only feed. A meeting row exists only when John preps it, a note arrives for it, or he logs it by hand.
- `series` holds a roster, default projects, group, a standing agenda skeleton and generated-block defaults. A calendar recurring event maps to a series; a calendar maps to a context.
- `parent_meeting_id` (one level) keeps multi-day sessions.
- **Stub to calendar** *(review)*: an undated stub can be attached to a calendar event, and the tool suggests it when a new event's people match. Attendee matching uses the series roster as well as invitees, since in-person 1:1s often have none.
- **Drop-ins** *(review)*:
  - A Granola note with no calendar match creates a meeting itself. If people or context are unknown, the review screen asks for them first, then runs matching against their open items.
  - **Log a meeting:** pick people, paste or type notes, and run the same processing. Covers unrecorded conversations and is the fallback if Granola fails.
  - Notes outside mapped Granola folders are ignored; any auto-created meeting can be discarded.

### Tables (about 30)

`contexts`, `people`, `person_emails`, `groups`, `group_members`, `projects`, `milestones`, `project_links`, `documents`, `series`, `series_people`, `meetings`, `meeting_people`, `meeting_projects`, `meeting_dismissals`, `agenda_lines`, `items`, `item_parties`, `item_events`, `item_todoist_links`, `notes`, `processing_runs`, `proposals`, `connections`, `bindings` (calendar/folder/Todoist project per context or project), `integration_events`, plus `users`, `sessions`, the OAuth tables and `mcp_write_receipts`.

## Workflow

One pipeline; every stage is optional, with no rail.

| Stage | Drop-in | Routine 1:1 / staff | Sporadic leadership | Project / committee |
|---|---|---|---|---|
| Capture | n/a | Items tagged with people/projects | Items tagged with the person | Items tagged with the project |
| Prep | None | Skeleton + placed items; skim suggestions | "Prep a meeting with…" places the batch | Full timed agenda |
| Run | Granola only | Brief pasted into Granola | Brief pasted into Granola | Timed brief pasted into Granola |
| Process | Automatic, or Log a meeting | Automatic | Automatic | Automatic |
| Review | One screen | One screen | One screen | One screen |
| Export | Optional | Optional | Optional | Recap to attendees |

- **Capture:** global quick-add (`@person #project`, kind prefix optional, everything optional) and MCP `capture_item`.
- **Agenda:** two levels (section, line). A line is free text or a reference to a live item, with public text and a private note.
- **Timing (optional):** minutes per line, computed start times, pinned starts, overflow flagged.
- **Generated blocks**, computed on render, defaults set on the series (on for project/committee meetings, off for 1:1s and drop-ins):
  - *Follow-ups due:* what attending people and groups owe, from placed items.
  - *Since last time:* decisions made, items closed and still open from the previous occurrence.
  - *Lookahead:* upcoming milestones and deadlines for the meeting's projects, plus the next linked meetings.
- **Brief for Granola:** agenda with planned start times, John's private notes and what attendees owe. A new renderer; Meeter's deliberately strips private notes.
- **Scratchpad:** Granola's own notepad, read through the API's `private_notes_markdown`. Processing sorts it three ways:
  - drafted content (a brainstormed event agenda) is saved whole as a `document` on the project hub, never split into items;
  - an unresolved circle-back becomes a proposed question or topic;
  - follow-ups to schedule become proposed actions for John or a "prep a meeting with…" stub.
- **Precise capture:**
  - *Verbatim lines:* `D:`, `Q:`, `A:`, `T:` lines in Granola's notepad are parsed **by code** before the model runs *(review)*, created as settled proposals with exact wording, and passed to the model as already captured. Their `detail` is the model's best-effort summary of the related discussion.
  - *Quick-add:* an item captured in the tool during a meeting attaches to it and is treated as settled.
- **Processing** *(review)*:
  - Runs as a background job, never inside the webhook response. Input: private notes, summary, transcript, agenda, and open items for the attendees and projects. Model configurable.
  - Output: new items, updates to existing items, a summary per agenda line.
  - `processing_runs` is keyed by note id and content hash. Each proposal has a fingerprint and rejections are remembered, so a re-delivered or edited note proposes only new material.
  - A meeting can hold several Granola notes. A note for a multi-day event asks which session at review.
  - A reconcile job catches missed webhook deliveries.
- **Review:** one screen; accept, edit or reject each proposal, or approve all. Proposals whose owner was inferred with low confidence are highlighted and excluded from approve-all. Accepted proposals can be undone. Nothing reaches real items or Todoist before approval.
- **Export:** recap computed on demand: summary, decisions, owed items grouped by person and group, lookahead. Copy as rich text or Markdown; `mailto:` fills recipients and subject while the body goes to the clipboard. Also a per-person "your items" snippet.

## Hubs

One page component, four filters:

- **Project:** description, status, milestones, working documents, owed items by owner, decision log, waiting topics, meeting timeline.
- **Person:** what I want to raise with them, what they owe, what I owe them, recent meetings.
- **Group:** what the group owes, what is waiting for it, decisions, members, meetings.
- **Series:** next agenda, skeleton, history.

## UI

- **Follow Expense Tracker's look** (`../Expense-Tracker`): card-oriented with clear visual hierarchy.
  - It has no card component or token system; the look is inline Tailwind v4 classes. Build the shared pieces once here: `Card` (standard, clickable, tile), `StatusBadge` with one colour map, `Input`/`Label`, `Modal`, `PageHeader`, `AppShell` with a context switcher.
  - Reference pages: `src/app/budgets/page.tsx`, `src/app/reports/page.tsx`, `src/app/page.tsx`.
  - Copy largely as-is: `globals.css`, `theme-provider.tsx`, `ThemeToggle.tsx`, `Toast.tsx`, `ui/Button.tsx`, `ui/EmptyState.tsx`, `ui/Spinner.tsx`, `ui/SortableList.tsx`.
  - Carry over: white cards on a grey page, `rounded-lg` with `shadow`, section headers with the action on the right, 1/2/3-column grids, pill badges, colour per section, class-based dark mode.
- **Minimal words** (written to the project `CLAUDE.md` in phase 0):
  - don't narrate the UI or explain design choices;
  - let icons, colour, position and grouping direct the user instead of prose;
  - labels short and action-oriented; no helper paragraphs or explanatory empty states.
- Item kind, owner type and status are distinguished visually, not by text.

## Todoist sync

- Syncs open actions and questions that name John as an owner. Group-only ownership does not sync.
- `due_on` maps to Todoist's **deadline** (`deadline_date`, verified in the API; needs Todoist Pro, which the account has). The tool sets the scheduled date once at creation (the day the item is approved, so it appears in Today for triage) and never reads or writes it again.
- Title, deadline and completion merge three ways against the snapshot in `item_todoist_links`; Todoist wins when both sides changed.
- *(review)* Remaining rules:
  - item done, dropped, converted to a decision, or John removed as owner: the task is closed;
  - a question ticked off in Todoist moves to "needs answer" in the tool, not closed;
  - reopen detection looks back 30 days; recurring tasks are unlinked; a deleted task unlinks quietly;
  - the Todoist project is set at creation from `bindings` and never moved;
  - dates are computed in John's time zone, not UTC.

## MCP

About 20 tools: `capture_item`, `list_items`, `update_item`, `convert_item`, `get_briefing` (meeting, person, group or project), `get_hub`, `list_meetings`, `get_meeting`, `set_agenda`, `log_meeting`, `process_meeting`, `list_proposals`, `resolve_proposal`, `render_recap`, plus people/group/project/milestone basics.

## Stack and reuse

Next.js App Router, TypeScript, Drizzle, Postgres, Tailwind v4, pnpm. Paths below are in `../Meeter`.

| Verdict | Files |
|---|---|
| Clean lift | `lib/connect/crypto.ts`, `lib/agenda/minutes.ts`, `lib/agenda/outline.ts` (+ `shape.ts`), `lib/jobs/scheduler.ts` (+ `lib/process-state.ts`), `lib/connect/granola/signature.ts`, `test/helpers/*`, `Dockerfile`, `compose.yaml`, `.github/workflows/deploy.yml` |
| Lift with trimming | `lib/oauth/*`, `lib/mcp/auth.ts`, `lib/mcp/idempotency.ts` (need `lib/auth/tokens.ts` and their tables); `lib/mcp/server.ts` (strip tool imports and the multi-user layer); `granola/client.ts`, `todoist/client.ts`, `google/calendar.ts`, `google/oauth.ts` (replace the 888-line `connections.ts` dependency with a small one); `granola/sync.ts` and `claimDelivery`, `targetForFolders`, `attendeesOf`, `startedAt` from `ingest.ts`; `lib/items/reconcile.ts` for proposal matching; `app/(app)/meetings/[id]/agenda/copy-for-granola.tsx` |
| Rewrite, using as reference | `google/sync.ts` (creates meetings eagerly), `agenda/generated.ts`, `agenda/render.ts`, `agenda/schedule.ts` (tied to Meeter's tree), `todoist/sync.ts`, the `meeting-processing` skill's prompt content |

Update the Granola client for `private_notes_markdown`, and check its `page_size` of 50 against the documented cap.

Deploy per the global notes: image built in Actions and pushed to GHCR, compose with `pull_policy: always` and no `build:` block, final job calling the Dockhand webhook (GET, `?secret=`).

## Build order

0. **Spec and scaffold.** `docs/SPEC.md`, `CLAUDE.md` with the UI rules, `git init`, scaffold, shared UI components, single login, OAuth/MCP plumbing, deploy pipeline. Live checks against Granola: when `note.generated` and `note.edited` fire, and what a no-calendar note contains.
1. **Items and hubs.** Contexts, people, groups, projects, milestones, links, items, events, quick-add, Inbox, the four hub pages, and `capture_item` over MCP. *Usable for capture.*
2. **Meetings and agendas.** Calendar feed, series, lazy meetings, stubs, sessions, candidate placement and suggestions, agenda editor with timing, generated blocks, outline import, brief for Granola. *Usable daily for prep.*
3. **Processing.** Log a meeting with pasted notes first; then Granola ingest, reconcile job, extraction, review screen, recap export. *Closes the loop.*
4. **Todoist and the remaining MCP tools.**
5. **Cutover from Meeter:** disconnect Meeter's Todoist link and Granola webhook, replace the installed `meeting-briefing` and `meeting-processing` skills, re-enter what is still open, leave Meeter read-only.
6. **Later:** Google Doc publish and comment harvesting, Gmail drafts, per-meeting block toggles, group list addresses, a clock-only companion view.

## Verification

- Vitest against a real Postgres (Testcontainers) for the item lifecycle, candidate rules and Todoist merge.
- Walkthroughs in the browser, each assigned to the phase that completes it:
  - Phase 2: sporadic (six items across two projects tagged to one person are all placed when a meeting is prepped; the stub later attaches to its calendar event without a duplicate); routine 1:1 (person items pre-placed).
  - Phase 3: drop-in from a Granola note with no calendar event; unrecorded drop-in via Log a meeting; committee meeting with a timed brief and recap.
- Step budget: routine prep and drop-in review each take no more than three actions.
- Candidate tests: a ten-person staff meeting places nothing person-only; a private 1:1 item never appears in a group agenda or recap; a dismissed suggestion stays dismissed.
- Context isolation: nothing from one context appears in another's agenda, hub or recap.
- Thread tests: topic to question to answer to linked decision to spawned action on one page; "report to" puts an answer on another group's next agenda; the lunch-menu note becomes one question owned by three.
- Processing tests: a `D:` line yields identical wording; re-delivery after review proposes nothing already handled; two notes on one meeting; a session note asks which session. Extraction quality is checked against fixture transcripts with expected output, run separately from Vitest.
- Todoist tests: reschedule in Todoist and sync twice with the date untouched; deadline changes propagate each way; conversion, owner removal, question ticked off, reopen, deletion, time-zone boundary.
- MCP: capture and briefing from a Claude session against the deployed instance.
