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
- Items with no party, project or target sit in a per-context **Inbox**. The Inbox also holds the Granola notes no folder filed (see Drop-ins): they belong to no context until filed, so they show whichever context is selected.

### People, groups, contexts

- **Contexts** are a hard boundary; projects, groups, meetings and items carry `context_id`.
- **People** are global, with `person_emails`; one person row is marked as John.
- **Groups** (`groups`, `group_members`) are context-scoped and act as parties alongside people. A meeting or series can belong to a group, which supplies its roster.
- **Capture context:** UI quick-add uses the selected context. MCP `capture_item` takes a context, or infers it from a named project or group.

### Agendas pull candidates; there are no anchors

*(review: bounded to stop flooding and leaks)*

**Placed automatically:**
- items targeting this meeting or its series;
- `with`-person items when the meeting is a 1:1 John made one: exactly two attendees (John and one other), and a stub, in a series, or made by hand. *(2026-10-03)* A one-off calendar event that happens to have one invitee (a hold, a site visit) only suggests them, and a meeting with a group is never a 1:1: what is for one member alone sits under "more" there, however few have joined so far.

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
- `parent_meeting_id` (one level) keeps multi-day sessions. *(2026-10-02)* A meeting with sessions keeps its own start and end, so it lists as the whole event; its agenda is the rollup of its sessions': its page shows each session's agenda in turn (no agenda or suggestions of its own), the brief and agenda copy are the sessions one after another, follow-ups and the recap draw on all its sessions, and an item aimed at it goes to its next session that is not over.
- *(2026-10-02)* A meeting's time is a start and an end, not a start and a length; the end may be days later.
- **Stub to calendar** *(review)*: an undated stub can be attached to a calendar event, and the tool suggests it when a new event's people match. Attendee matching uses the series roster as well as invitees, since in-person 1:1s often have none.
- **Drop-ins** *(review)*:
  - A Granola note with no calendar match creates a meeting itself. If people or context are unknown, the review screen asks for them first, then runs matching against their open items.
  - **Log a meeting:** pick people, paste or type notes, and run the same processing. Covers unrecorded conversations and is the fallback if Granola fails.
  - *(2026-10-02)* A note in no folder at all, outside mapped Granola folders, or in folders mapped to two contexts, is filed on the meeting already made for its calendar event if there is one, wherever it is; otherwise it is held in the **Inbox**, in no context and unprocessed, until John files it into a context (which then matches or makes its meeting there as a mapped folder would) or dismisses it. Any auto-created meeting can be discarded.
  - A folder maps to a context, or to one project in it; a note from a project's folder puts that project on its meeting. A subfolder follows the nearest mapped folder above it.

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

- **Capture:** global quick-add (`@person #project >series`, kind prefix optional, everything optional) and MCP `capture_item`. *(2026-10-03)* `>series` raises the item at that series' next meeting; a token runs across words, so `>check-in` reaches "Adlene/John Check-In".
- **Agenda:** two levels (section, line). A line is free text or a reference to a live item, with public text, a public description, a leader (any person, John included) and a private note. The description and leader go out in the brief and the agenda copy; the private note only in the brief.
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
6. **Today view** *(asked for 2026-10-01)*. A unified dashboard across all contexts: the next meetings and the items that need attention, whichever context they live in. This is the one deliberate exception to "nothing is listed across contexts", so it is read-only, each row shows its context, and opening a row switches to that context. To settle when it is built: which items count (due, overdue, owed by John, pending review), and whether it replaces the per-context home page or sits above it.
7. **Meetings beyond 14 days** *(asked for 2026-10-01; done 2026-10-03 except the hubs' reach)*. The calendar feed asks for the next 14 days and stops. Add "load more", or a date selector, to the upcoming list on `/meetings`, and the same reach on the project, series and group hubs, where only that hub's meetings and events are shown. The feed takes a window instead of a fixed horizon; the cache is keyed by it. The home page's "Next up" (`app/(app)/page.tsx`) shows only the first three of the upcoming list *(John, 2026-10-03)*. Let it show more: a horizontal scroll of meeting cards past those three, ending in a "More" card that opens `/meetings`, plus a date jump that opens `/meetings` at that day. The selector on `/meetings` is the only date picker, and home links into it. The home page also makes clear which of these are prepped. Today "Next up" mixes a `MeetingCard` (a meeting row exists) and an `EventCard` (calendar only) in one grid, and they read alike. Split them into "To prep" (calendar events with no meeting, each with its Prep action) and "Prepped" (meetings, each showing its agenda count). Or keep one time-ordered row and mark each card's state with icon and tone from `StatusBadge.tsx`. To settle which. Also whether a meeting with an empty agenda (made, never worked on, like Oct 6's check-in) counts as prepped. A date selector that reaches backwards would also give the look-back the handoff says a past, never-prepped event needs. `/meetings` is one long page today: Review, Upcoming, Later, Undated, Past *(John, 2026-10-03)*. Split it into two tabs, `/meetings` (upcoming) and `/meetings/past`, each with its own reach. Upcoming gets "load more" and the date jump, and keeps Later and Undated. Past pages backwards by date and is where the look-back for a never-prepped event lives. Review (meetings with proposals waiting) shows above both tabs while it has anything, since it is the next thing to do whichever tab is open.
8. **Series aligned with recurring meetings** *(asked for 2026-10-01; mostly done 2026-10-03, see the handoff)*. Today a series and a calendar recurring event are joined only when "make a series" is pressed on one of the event's occurrences (`series.calendar_series_id`); a series made by hand never finds its calendar event, and a recurring event never suggests its series. To think through: offering a series for a recurring event the first time it is prepped; linking an existing series to a recurring event; whether the roster and the title follow the calendar or stay John's; what a changed or split recurrence (Google issues a new recurring id) does to the link; and whether a series' "next" comes from the calendar rather than from the last meeting row.

   A case seen in use *(John, 2026-10-03)*: the Oct 13 "Adlene/John Check-In" was made by hand, so it had no series and no `calendar_event_id`. Nothing joined it to the calendar occurrence at the same time. Only an undated stub is offered an event to attach to; a dated meeting made by hand never is, and the upcoming list can show it next to its own event. Offer the match: a meeting made by hand that overlaps an event with the same people (or the same title) is shown as that event's meeting, and offered "Link" to attach it as `attachStub` does, taking the event's series. Better still, the New meeting form offers the calendar events on its date before making a fresh row. The series and both meetings also have no people, though Adlene is in the directory. The event probably names no invitees we know, so the roster was made empty and neither meeting is treated as a 1:1 with her. A series whose roster is empty should ask for one.

   The series page shows the link as an icon-only chip: a calendar icon, a link icon, and × to unlink *(John, 2026-10-03: "what is this?")*. Show the event instead: its title and recurrence ("Tue 10:00, weekly"), opening the next occurrence. Put unlink behind a confirm in the series' Edit. When there is no link, offer "Link calendar" there, listing the context's recurring events.

   Two more from the same series *(John, 2026-10-03)*:
   - **"Make a series" left the roster empty.** `seriesFromEvent` fills the roster from `matchedPeople(event)`: the event's attendees whose email is already in `person_emails` when the feed is read. The organizer (Google's `organizer`, which is not always among `attendees`), an invitee at an address nobody has yet, and a person added to the directory after the feed was cached are all dropped without a word. Count the organizer as an attendee. When making a series, list the invitees it could not match, with "Add" to make each one a person (with that email) on the roster. On the series page, offer "From calendar" to refill the roster from the current invitees.
   - **"Me" is not on the roster.** That is by rule: John is at every meeting and never a `series_people` row. But it reads as missing. Show "Me" as a fixed first chip on every roster and attendee list, with no remove, so the list looks complete. Don't offer it in the picker.
9. **Gaps noted in use** *(John, 2026-10-01)*.
   - **Adding attendees to a meeting.** A meeting's people should be editable after it is made: add or remove a participant on the meeting page, including someone not yet in the directory. To settle: whether a change on one occurrence is offered to the series roster, and whether people added by hand survive a calendar event whose invitees differ.
   - **A public description on agenda lines.** *Done 2026-10-02, with a leader per line; it goes out in the agenda and the brief, not yet the recap.* A line has its text and a private note only John sees; there is nowhere for detail the attendees should read. Add a public description that goes out in the agenda and the recap, kept apart from the private note, which still never leaves.
   - **A count on Inbox in the nav** *(John, 2026-10-03; done)*. The Inbox now fills on its own (unfiled Granola notes), but only the home tile shows how much is waiting. Put the same count as the tile (`counts.inbox` plus `countUnfiledNotes`) as a badge on the Inbox link in the nav, on every page and at phone width, hidden at zero, with its tone from `StatusBadge.tsx`.
   - **File a held note onto a meeting John picks** *(John, 2026-10-03; done)*. File in the Inbox already looks for a meeting in the chosen context (the one for the note's calendar event, then the one under way when it started) and makes a new one only when it finds neither. But that choice is never shown. When nothing matches, or the match is wrong, John cannot point the note at a meeting he knows it belongs to, and a duplicate meeting is made. Next to File, add "Link": a meeting picker in the chosen context, with recent and upcoming meetings first, that can open a meeting to choose one of its sessions. A meeting with sessions takes the session, not the parent, as for any note. Then queue the run and open the review, as File does. Also show what File will do before it runs ("→ Staff meeting, Tue 10:00" or "New meeting"). `file_note` over MCP takes a `meeting` too. Code: `fileHeldNote` in `lib/connect/granola/unfiled.ts`, `placeNote` in `ingest.ts`.
   - **Sections in each session of a rollup** *(John, 2026-10-03; done)*. On a meeting with sessions, each session's agenda (`SessionAgenda`) is an `AgendaCard` alone. The tools on a single meeting's agenda (Section, Import, quick-add aimed at it) are missing, so a section can only be added by opening the session's own page. Give each session on the rollup the same action row as a meeting's agenda, aimed at that session. Code: `app/(app)/meetings/[id]/page.tsx` (the agenda tools and the `rollup` branch), `components/meetings/SessionAgenda.tsx`.
   - **A section as a timebox** *(John, 2026-10-03; done as proposed)*. Today a section has a pinned start and its own minutes, but the minutes field disappears once any of its lines carries minutes. From then on the section lasts as long as its lines add up to (`lib/agenda/schedule.ts`). So "Budget, 45 min" cannot be set with its lines fitted inside. The timing also lives only in the Edit section modal, while the section header shows a start and a length. To settle how a section's time and its lines' time interact. The proposal: the section's minutes are always editable and are its length. Lines with minutes use them up in order. Lines without minutes share what is left equally, shown as computed rather than set. If the lines' minutes add up to more than the section's, the overrun is reported, the same way a meeting overrunning its end is, and the next section still starts at the section's end (or at its own pinned start). A section with no minutes keeps today's behaviour (the sum of its lines). Also open: whether a pinned start on a line inside a timed section may fall outside it, and whether the header shows used/budget ("30 / 45 min"). Needs cases in the schedule tests. The brief and the agenda copy show the section's slot.
   - **Milestones are dates, not tasks** *(John, 2026-10-03; done)*. A milestone is a reference date on a project ("Board vote", "Go-live"). The work toward it is action items. Drop the done toggle: the checkbox on the project hub, `doneAt` in `setMilestoneDone` (`lib/projects/projects.ts`), and `done` in the MCP milestone tools (`lib/mcp/tools/directory.ts`). Drop `milestones.done_at` with a migration. Whether a milestone is past or upcoming then comes from its date alone. The hub lists upcoming milestones first and past ones muted beneath them. The agenda lookahead (`generated.ts`) already skips past dates, so it only loses its `doneAt` filter. A project's "next milestone" (`nextMilestones`) does not filter by date: it relies on old milestones being ticked off. It needs a "from today" filter in John's time zone instead. A milestone with no date stays listed as undated. The lookahead change needs a case in `test/candidate-rules.test.ts`.
   - **Search-and-add for people lists** *(John, 2026-10-03; done)*. Adding a group member is a modal with a `<select>` of everyone, one person per trip. Replace it with a type-ahead that stays open and never needs the mouse: type a few letters, Enter takes the top match and clears the box for the next one, Backspace on an empty box removes the last pick, and Esc or ⌘Enter finishes. Typing a name that matches nobody offers to add them as a new person. Build it on `PartyPicker` (`components/processing/PartyPicker.tsx`, already used by Log), people only, as one shared piece shown on `/design`. Use it everywhere a list of people is added to: group members (`app/(app)/groups/[id]/page.tsx`), the series roster (today a `CheckList`), and a meeting's attendees (the item above). `addMemberAction` takes several ids at once.
   - **Time or minutes, not both, on an agenda row** *(John, 2026-10-03; done: minutes, with an optional pin)*. A line's modal and a section's both show "Starts at" and "Minutes" side by side, and it isn't clear which one wins. The clock (`schedule.ts`) uses both: a pinned start sets the clock, then the minutes move it on. Two ways to make it one choice:
     - **Minutes, with an optional pin** *(proposed)*. The row's modal shows only Minutes. A pin toggle reveals "Starts at" for the rare fixed slot ("Lunch 12:00"), and a pinned row shows a pin icon next to its time. A pinned row keeps its minutes, so nothing about the clock changes. This is mostly a form and display change.
     - **Either/or.** A row takes Minutes or an At time, never both. A pinned row then lasts until the next pinned row or the meeting's end, less the minutes of the rows in between, so the clock has to look ahead.

     Decide this together with "a section as a timebox" above, so a row and a section offer the same choice.
   - **Groups among a meeting's attendees** *(John, 2026-10-03)*. A meeting or series has one optional group (`meetings.group_id`), set only from a select in the edit form. It feeds the suggestions but is shown apart from the people. Let the attendee picker (the two items above) take groups as well as people, as `PartyPicker` already can, and show a group as a chip with the group icon among the people. To settle:
     - one group per meeting or several (a `meeting_groups` table, with `candidates.ts` reading every group);
     - whether adding a group also adds its members as people (a copy, editable per meeting) or the group stands for them live;
     - whether a group on a series' roster carries to each meeting.

     Each answer needs cases in `test/candidate-rules.test.ts`. The suggestion rules change with more than one group, and the leak rules need checking for a meeting that mixes a group with people outside it.
   - **A group's email address** *(John, 2026-10-03)*. A distribution list (acplanning@umcna.org) is on an invite as one attendee. Today it matches nobody and is listed as an unmatched invitee. Let a group hold addresses, as a person does (`group_emails`, the same shape as `person_emails`; an address is on one person or one group, never both). An invitee matching a group's address brings the group to the meeting, wherever invitees are matched: prep from an event, "make a series", a Granola note's attendees. On the group page, emails as removable chips with Add. Where an unmatched invitee is shown, "This is…" offers groups as well as people. Over MCP, `create_group` and an update take `emails`. Depends on **Groups among a meeting's attendees** above: with one group per meeting, a list address fills `group_id` only when it is empty, and a second list is dropped. Cases in `test/candidate-rules.test.ts` and the invitee-matching tests.
   - **"I owe" by horizon** *(John, 2026-10-03; proposed)*. "Reimagine the journal process" (a conversation months off) sits next to "Arrange the staff Christmas lunch" (weeks). The home list is every open item John owns, in one run. Proposed:
     - **The list sorts by due date**: overdue and due soon first, then the undated, then what is due further out.
     - **"Later" is set after the fact, never at capture**: an action on the item (its page, and a swipe-free icon on the card) with an optional date. Undated, the item is parked: it leaves "I owe" for a collapsed "Later" section and stays there until brought back. Dated, it comes back on its own that day. `items.later_on` (a date, or a far sentinel for undated) is separate from due, which stays a deadline. Bringing it back clears it.
     - A due date coming close brings a parked item back regardless, so a deadline is never hidden.

     Waiting on gets the same treatment.
   - **Several emails per person** *(John, 2026-10-03; done)*. The table already allows it (`person_emails`, one marked primary), and invitee matching reads every row. But the person form and `create_person` take one email, and saving it replaces the primary (`setPrimaryEmail` in `lib/directory/people.ts`). On the person page, list each email as a removable chip with Add, and a way to choose which is primary. Over MCP, `create_person` and an update take `emails`. Wherever an unmatched invitee is shown (series from an event, an unfiled note's attendees, a meeting's invitees), offer "This is…" to add that address to an existing person, next to "Add" for a new one. An address already on someone else is refused with their name, as now.
   - **Archive, then delete, everywhere** *(John, 2026-10-03)*. Today the screens are uneven. A meeting, a series, a milestone and a link are deleted outright with one confirm. People, groups, projects and contexts can't be removed at all. Items close as done or dropped. One flow for every kind:
     - **Archive** sets `archived_at`. The row leaves every list, picker, candidate rule and MCP list, but anything that points at it still reads (an old meeting still names an archived person).
     - **An archived row** shows muted on its own page with Restore and Delete. Each hub gets a collapsed "Archived" section.
     - **Delete** is offered only on an archived row. It says what it takes with it, refuses while something still depends on it (a person on open items, a project with meetings), and names what does.

     To settle: whether a meeting is archived or simply deleted (it has a date, so a past one already leaves the lists); whether items keep done/dropped and skip archive; what archiving a context does to its bindings and Granola folder; and whether delete is real or a long-kept soft delete. Every list query and the leak rules need the filter, with cases in `test/candidate-rules.test.ts`.
   - **A roster change reaches the series' upcoming meetings** *(John, 2026-10-03; done as proposed)*. The roster is copied onto a meeting when it is prepped, and never again. Adding Adlene to "Adlene/John Check-In" after Oct 6 and Oct 13 were prepped left both with no people. Neither became a 1:1 with her, so her topic ("Accountability process for team-to-team collaborations", captured `@Adlene-Kufarimai`) was neither placed nor suggested, though it shows on her page. When a roster changes, apply the change to the series' meetings that are not over. Do it without asking for a meeting whose people still match the old roster; offer it ("Also update 2 upcoming meetings") for one edited by hand. Then re-run placement on each (`placeAutomatic`), so a person item is placed as it would have been at prep. Same for the series' group and projects. Needs a case in `test/candidate-rules.test.ts`: an item for a person added to the roster after prep is placed on the next meeting. In the Edit form of a meeting in a series, the series' roster is pre-selected among its people: shown checked, removable for this meeting alone ("Adlene is out this week"). Choosing a series for a meeting that had none (as with Oct 13, made by hand) does the same. The alternative, read-only inheritance with only extra people added per meeting, can't record an absence. So the proposal is pre-selection, with a meeting remembering who it dropped, so a later roster change doesn't put them back.
   - **Raise at the next meeting for a project** *(John, 2026-10-03; done as proposed, no quick-add token yet)*. "Raise at" takes one meeting or a series (`items.target_meeting_id` / `target_series_id`). Add a third target, a project: the item is placed by prep on the next meeting not yet over that carries that project, and stays aimed there until it is discussed. It does not lapse when one meeting passes without it. It can be set when no such meeting exists yet: the item waits, shown on the project's hub as "For the next meeting", and is placed when the first meeting with that project is made (prepped from the calendar, made by hand, logged, or an undated stub). Offered in the picker as "Next for <project>", defaulting to the item's own project, and in quick-add (a token to settle). `target_project_id`, with `items_one_target` widened to three. To settle: a meeting with sessions (proposed: its next session, as for any placement), and, with projects within projects (item 11), whether a meeting tagged with a child or parent project counts (proposed: the project or its descendants). Cases in `test/candidate-rules.test.ts`.
   - **Markdown in long text.** *(Done 2026-10-03.)* Description and long-text fields generally (item detail, resolution, project description, agenda line description and private note, documents, notes) should accept Markdown and render it, with one renderer shared by the screens and by the brief, agenda and recap exports.
   - **Calendar events are not 1:1s** *(John, 2026-10-03; done)*. Prepping "Hold for Finley Center Site Visit" (Adlene the only invitee, as an FYI) placed her topic "Accountability process" as though it were her 1:1. `with` items are now placed only on a 1:1 John made one (a stub, a series, by hand); a one-off calendar event with one invitee only suggests them, and a meeting with a group is never a 1:1, however few have joined it. What should reach her 1:1 is aimed at its series ("Raise at" → the series), which places it on the next occurrence and nowhere else.
   - **The Inbox is the review queue** *(John, 2026-10-03; done)*. Proposals waiting on a session were reachable only from the session's own page. The Inbox now lists every meeting and session with proposals waiting (a session named with its meeting), and they count toward the Inbox badge and tile.
   - **Delete a stray item** *(John, 2026-10-03; done)*. A "test" item could only be dropped. An item that stands alone (no meeting it came from, no thread) has Delete on its page; anything else is part of the record and is dropped. Folds into **Archive, then delete** above when that is settled.
   - **Date jump on iOS** *(John, 2026-10-03; done)*. An empty date input has no placeholder on iOS and showed as a grey box in dark mode. It is a calendar button over the native input now, and native controls follow the dark theme.
   - **Bump a line to another session** *(John, 2026-10-03; done)*. "This topic got bumped to the next session." On a session, Edit line (or Edit section) has a Session field; picking another session of the same meeting moves the row there, at the end of its agenda, and an item it carries is turned away from the session it left so placement does not put it back.
   - **Breadcrumbs everywhere** *(John, 2026-10-03; done)*. Installed as an app there is no back button. Every page below a section shows the way up (`Breadcrumbs`, through `PageHeader`'s `crumbs`); an item goes back to its project, the meeting it came from, its person or group, or the Inbox.
   - **Phone-width overflow** *(John, 2026-10-03; done)*. Date and time inputs shrink inside narrow forms (iOS gives them an intrinsic width), long names truncate in badges and party chips, and headings wrap a long word such as an email address standing in for a name.
10. **Installable as a PWA** *(John, 2026-10-01; done 2026-10-03: an offline page, shortcuts to Inbox and Meetings, no offline capture)*. A web app manifest (name, icons, theme colours for light and dark, standalone display) and a service worker, so the app installs to a phone's home screen and a desktop dock and opens without browser chrome. To settle: what, if anything, works offline (the minimum is an offline page; capture queued offline is a larger piece), and whether quick-add gets a home-screen shortcut or share target.
11. **Projects within projects** *(John, 2026-10-03; done as proposed, except offering to pause children and the Todoist mapping)*. A project can have a parent: "Annual Conference" → "2027 Annual Conference" → "AC2027 Worship". Items about the standing system go on the top, the year's general items on the middle, and worship-specific items on the leaf. `projects.parent_id`, same context, no cycles, any depth (expect three). To settle:
   - **Agendas (the leak rules).** A meeting tagged "2027 Annual Conference": are its children's items suggested too (proposed: yes, as suggested, grouped by child, never placed by prep), and its parent's (proposed: no)? A meeting tagged "AC2027 Worship": does the parent's open work show (proposed: a collapsed "From 2027 Annual Conference" group)? Cases in `test/candidate-rules.test.ts`.
   - **The hub.** A parent's page lists its children as cards with their status and next milestone. Its items, decisions and meetings either include the children's (rolled up, each row showing which child) or are its own only. Proposed: its own, plus a "Include sub-projects" toggle.
   - **Generated blocks reach both ways.** The lookahead (the next linked meetings and milestones) of a meeting tagged with a project reads up and down its line: "AC2027 Worship" lists the upcoming meetings and milestones of "2027 Annual Conference" (and "Annual Conference"), and "2027 Annual Conference" lists those of "AC2027 Worship". Proposed: ancestors and descendants, not siblings or cousins, each row naming its project. Same for "since last time" and follow-ups if they read by project. Cases in `test/candidate-rules.test.ts`.
   - **Capture.** Quick-add's project token resolves a child by its own name ("AC2027 Worship") or a path ("AC2027/Worship"). The project picker shows the tree indented.
   - **Status.** Whether pausing or finishing a parent does anything to its children (proposed: nothing on its own; offer it).
   - **Todoist (phase 4).** Whether the tree maps to Todoist sub-projects. Settle this before phase 4 binds projects.
12. **Later:** Google Doc publish and comment harvesting, Gmail drafts, per-meeting block toggles, group list addresses, a clock-only companion view.

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
