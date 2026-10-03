# Handoff: build order items 7–11

Updated 2026-10-03. Read `docs/SPEC.md` (the approved design) and `CLAUDE.md` (UI rules, layout, commands, conventions) first; this file only covers where things stand and what to do next.

## Build order 7–11 (2026-10-03)

On branch `claude/serene-euler-fbpsv1`, one commit per item, not yet deployed. Migrations `0006` (drop `milestones.done_at`), `0007` (`meeting_absences`), `0008` (`projects.parent_id`), `0009` (`items.target_project_id`, `items_one_target` over three columns) run at boot. `pnpm test` (578 tests, 37 files), `pnpm typecheck` and `pnpm lint` are clean. Each screen was walked in a production build with Playwright, in light, dark and at phone width.

**Built**

- **Inbox count** on the nav link, in the phone drawer, and on the menu button while the drawer is closed.
- **Milestones are dates.** No done toggle; upcoming, then undated, then past (muted). `nextMilestones` takes today.
- **Agenda tools on each session** of a rollup (Import, Section, quick-add aimed at the session).
- **Link a held note.** The Inbox card shows where File would put it; Link picks a meeting near the note's time in the selected context (a session, if it has sessions). `file_note` takes `meeting`.
- **Several emails per person**: chips with primary star, Add, remove. `create_person` takes `emails`; new `update_person`. A taken address is refused with its holder's name.
- **Search-and-add** (`PartyPicker` with `allowNew`): group members, series roster, new series, the meeting form. ⌘Enter, or Esc once something is picked, submits. `pickedPeople` in `lib/web/action.ts` reads it and makes new people.
- **Roster carry** (`lib/meetings/roster.ts`): a series' roster, group or projects reach its meetings not over that still match the old roster; others get "Update N upcoming" on the series page. Absences are remembered per meeting. A meeting newly in a series takes its roster (edit form, MCP, `attachStub`).
- **Timebox and pin**: a section's own minutes are its length; unset lines share what is left (shown italic); overrun shown as "55 / 45 min" in red and counted in the overflow. A row's modal shows Minutes and a pin that reveals Starts at.
- **Markdown** (`lib/core/markdown.ts`, `components/ui/Markdown.tsx`) in item detail and resolution, project description, line description and private note, documents. HTML copies render it; text copies keep it. Line descriptions now also go out in the recap.
- **PWA**: manifest, icons (`public/icons`, `app/icon.svg`, `app/apple-icon.png`), `public/sw.js` caching only `offline.html`.
- **Meetings beyond 14 days**: `/meetings` (Upcoming: `?from=`, More adds two weeks up to 180) and `/meetings/past` (two weeks back at a time, Earlier, a date; never-prepped events can be prepped). Review shows above both. Home's Next up is a scrolling row of up to twelve with a More card and a date jump. Meeting cards there and on Upcoming show the agenda's row count, green when prepped, amber when empty.
- **Series and calendar**: the organizer counts as an invitee; a hand-made meeting overlapping an event (same title or someone in common) is offered on the event card to link; the series page shows its event (title, weekday and time, cadence), Edit links one of the context's unlinked recurring events or unlinks with a ticked box, unmatched invitees can be added (new person or "This is…"), From calendar adds the known ones. Me is the first chip on rosters and meeting people.
- **Projects within projects**: see item 11 in the spec; cases in `test/candidate-rules.test.ts`. Sub-projects' items are suggested by sub-project; a parent's items sit under the collapsed "more"; siblings never. The lookahead reads up and down. Pickers are indented (`listProjectChoices`), `#AC2027/Worship` and MCP paths resolve.
- **Next meeting for a project** (`nextForProject` in `candidates.ts`): placed on the next meeting not over carrying the project or a sub-project, waiting on the hub until there is one; discussed clears it. `target_project` over MCP.

**Decisions made without John**

- A meeting with an empty agenda counts as not prepped (amber). One time-ordered row on home rather than "To prep" and "Prepped" lists.
- The "Update N upcoming" sync only adds what a hand-edited meeting lacks; it never removes.
- Link on an unfiled note uses the selected context's meetings; to link into another context, switch first.
- A timebox's unset lines share by whole minutes, the odd minutes to the first lines. A pin inside a timebox may fall outside it.
- The section header shows "used / box"; "used" is the lines' own minutes only.
- New people from a picker are made when the form is saved, even if the rest of the form is then refused.
- Esc in a picker first clears what is typed; with picks and an empty box it submits.
- An item aimed at a project's next meeting is cleared only by marking it discussed (or closing it), not by the meeting passing.
- The project hub's Sub-projects section shows only its header and New when there are none, rather than an empty-state box on every leaf.

**Not done, needs John**

- **Archive, then delete** (item 9): settled 2026-10-03, not built. Meetings archive then delete; done/dropped is an item's archive; soft delete with a 30-day purge and Restore from a "Deleted" list on Settings. Archiving a context (dormant bindings, held notes to the Inbox) approved as written in the spec.
- **Groups among a meeting's attendees** and **group emails** (item 9): settled 2026-10-03, not built. Several groups per meeting and series; live until the meeting is over, then frozen; carried from the series roster. The freeze is a roll call on the meeting page while it is under way, falling back to the first open or processing after its end.
- **"I owe" by horizon** (item 9): approved 2026-10-03, not built. `parked_at` plus a nullable `later_on`.
- **Adding attendees on the meeting page**: settled 2026-10-03, not built. Offer "Also add to the series"; calendar invitees only add, and hand edits stay.
- **The reach on project, series and group hubs** (item 7) and the New meeting form offering the calendar events on its date (item 8).
- **A quick-add token for "next meeting for a project"**, and offering to pause a parent's sub-projects.
- **Todoist and sub-projects** must be settled before phase 4 binds projects.
- Phase 4 (Todoist) is untouched. Phase 5 (cutover from Meeter) is done (John, 2026-10-03).

## Earlier: phase 3 deployed and verified (2026-10-02)

## Usability gaps before phase 4 (2026-10-02)

Three gaps John raised after using phase 3. On branch `claude/festive-clarke-eiv954`, not yet deployed. Migration `0005` adds `agenda_lines.description` and `leader_person_id`, makes `notes.meeting_id` nullable, and adds `notes.filing` and `notes.dismissed_at`.

- **Agenda lines carry a description and a leader.** The description is public: it goes out in the agenda copy and the brief, under the line, while the private note stays in the brief only. The leader is any person in the directory, John included ("Me" on screen), and follows the line text as `— Name`. A section has neither. Edited in the line's modal; over MCP as `description` and `leader` on `set_agenda` and `edit_agenda`. Not yet in the recap.
- **The Inbox holds Granola notes that no folder filed.** A note in no folder at all (Granola does not require one), in no bound folder, or in folders bound to two contexts, used to be dropped. Now it is filed on the meeting already made for its calendar event if there is one (in whichever context), and otherwise saved with no meeting: no context, no run. The Inbox lists these under Meetings whichever context is selected, and the home tile counts them. File puts one in a context (the selected one, or a pick when there are several), matching or making its meeting there exactly as a bound folder would, queues its run, and opens its review in that context. Dismiss hides it; a later delivery updates it without bringing it back, and binding its folder files it. The reconcile job now lists every recent note on the account, not just bound folders. MCP: `list_unfiled_notes`, `file_note` (`dismiss: true` to wave one away). Code: `lib/connect/granola/unfiled.ts`, `placeNote` in `ingest.ts`.
- **Start and end, and sessions as a rollup.** Every meeting form (new, edit, session, Log) takes a start and an end instead of a start and minutes; moving the start carries the end, and a start with no end gets an hour. A meeting with sessions keeps its own start and end (John, 2026-10-02: "planning retreat" should show as an event wherever meetings are listed), and its agenda is the rollup of its sessions': its page lists each session with its own editable agenda instead of an agenda and suggestions of its own, Copy brief and Copy agenda give the sessions one after another, follow-ups and "since last time" read across its sessions, its lookahead does not list its own sessions, and an item aimed at it is placed on its next session that is not over. `prep_meeting` takes `session_of` to make a session over MCP.

**Decisions made without John**

- An unbound note whose calendar event already has a meeting is filed there without asking, in that meeting's context. Nothing looser (time, people) is used without a folder.
- Unfiled notes show in every context's Inbox: they have no context, so nothing crosses. Only their title, time and attendees are shown before filing.
- Filing a note opens its review rather than the meeting page.
- A meeting's own agenda lines from before it had sessions stay and are shown above the sessions; nothing new is placed there.
- The leader is a person, not a group or free text.

**How it was checked:** `pnpm test` (552 tests, 35 files), `pnpm typecheck`, `pnpm lint`. A production build walked in Playwright in light, dark and phone width: the Inbox, filing into another context, the rollup page, the line modal, the session form's end following its start.

## Phase 3: complete

Everything below was pushed to `main` on 2026-10-01 and deployed. John confirmed on 2026-10-02 that the deploy, a real Granola note, a real extraction and the extraction eval all check out. `pnpm test` passes (537 tests, 35 files); `pnpm typecheck` and `pnpm lint` are clean. Migrations `0003` and `0004` run at boot on deploy.

**What exists**

- **Schema:** migration `0003` adds `notes`, `processing_runs`, `proposals`, `documents`, `integration_events`; `0004` adds `notes.attendees`.
- **Unknown attendees:** addresses a Granola note names that the directory does not have are kept on the note and shown as amber pills at the top of the review screen (`lib/notes/attendees.ts`, `components/processing/UnknownAttendee.tsx`). Each is named as a new person, given to an existing one, or skipped; a named person joins the meeting. Not exposed over MCP.
- **Pipeline:** `lib/notes`, `lib/processing` (`verbatim.ts` parses `D:` `Q:` `A:` `T:` lines by code; `extract.ts` and `prompt.ts` call the model behind the `Extractor` seam in `types.ts`; `run.ts` queues and processes; `proposals.ts` holds accept, edit, reject, undo, approve all), `lib/meetings/log.ts`, `lib/documents`. Nothing reaches `items`, `documents` or `meetings` before a proposal is accepted. A rejected proposal's row is kept, which is how a rejection is remembered.
- **Jobs:** `lib/jobs` with `process-notes` (every 60 s) and `granola-reconcile` (every 15 min), started from `instrumentation.ts`. `WORKER=off` keeps the timers off.
- **Granola:** `lib/connect/granola` (client, signature, connection and folder bindings, ingest, webhook, reconcile), `app/api/webhooks/granola`, a Granola section on Settings. **The API key is pasted on Settings, not read from the environment**; compose passes only the optional `GRANOLA_WEBHOOK_SECRET`. A folder binds to a context, or to one project in it (added 2026-10-02): a note arriving from a project's folder puts that project on the meeting it is filed on, alongside any it has; a re-delivered note changes nothing. Subfolders inherit from the nearest bound folder, so a subfolder bound to the whole context names no project. A note with no meeting to match makes its own through `meetingFromNote` in `lib/meetings/prep.ts`.
- **Screens:** Log (a modal on `/meetings`), `/meetings/[id]/review`, `/meetings/[id]/recap`, documents on the project hub, a pending-review badge on meeting cards, Review and Recap buttons on the meeting page. Server actions are in `app/(app)/meetings/processing-actions.ts`.
- **Recap:** `lib/agenda/recap.ts`, computed on demand, drawn only from items placed on the agenda or originating in the meeting.
- **MCP:** `log_meeting`, `process_meeting`, `list_proposals`, `resolve_proposal`, `render_recap` in `lib/mcp/tools/processing.ts`.
- **Moving to another context:** `lib/meetings/move.ts`, a Move control on the meeting and series pages, `context` on `update_meeting`, `move_to` on `update_series`. The calendar feed routes each event to its meeting's context, else its series', else its calendar's. A moved meeting's notes are queued again in the new context.
- **Series adoption fix:** making a series adopts already-prepped occurrences in the same context.

**How it was checked**

- Leak and context rules read line by line: the recap, the move, the feed routing, the proposal accept path, the processing server actions, and Granola's `contextForFolders`, `findMeeting` and `ingestNote`.
- Browser (Playwright, production builds, light, dark and phone width): the move flows; Log, review, recap, documents and the badge; the Granola section of Settings against a faked Granola host.
- **Real model and real Granola** checked by John on the deployed instance (2026-10-02). Dockhand has `ANTHROPIC_API_KEY` and `EXTRACTION_MODEL=claude-opus-5-5` (John, 2026-10-01); compose's fallback when unset is `claude-fable-5-1`.

**Decisions made without John, confirmed 2026-10-02**

- A meeting that has produced items, an accepted proposal or a document cannot be moved. A series move takes the occurrences that can go; the rest stay, detached, and a toast gives the count.
- Log a meeting allows no people and no group (titled "Meeting"). Logged with no time, it starts and ends now, so it lists under Past.
- In a recap John appears as an owner of what he owes. Recap lines end in `[action]` or `[question]`.
- The public agenda's lookahead lists every dated item on the meeting's projects, as the spec says; the recap's lists only what the meeting raised.
- Granola: a note in folders bound to two contexts is ignored (two projects in one context are both put on the meeting); an undated stub is never matched by time; a re-delivered note stays on the meeting it was filed on, even after a folder is rebound; binding a folder files up to three days of its notes.
- The model is sent every open item of the context that names an attendee, is on one of the meeting's projects or is on its agenda, plus the whole people directory by name.
- The extraction request turns on Anthropic's server-side refusal fallback, so a declined request may be served by another model while the run records the configured one.

**Known gaps**

- A failed run is retried only by hand (Retry on the review screen, or `process_meeting`). A run stuck in `running` is re-queued after 15 minutes with no cap on attempts.
- A pending proposal whose line was later removed from the note lingers.
- Pending badges are not shown on the project, person and group hubs or on home.
- `kick` runs the job even with `WORKER=off`; only the MCP tools guard against that.
- The series page does not name which occurrences stayed after a move.
- Scratch databases `mm_move`, `mm_screens`, `mm_granola` in `mm-dev-db`, and `.next-move`, `.next-screens`, `.next-granola` in the repo (ignored by git), can be dropped.

**Added to the spec's build order** at John's request: a cross-context Today view (6), meetings beyond 14 days (7), series aligned with recurring calendar meetings (8), gaps noted in use: attendees, a public description on agenda lines, Markdown in long text (9), installable as a PWA (10).

## State

Phases 0, 1 and 2 are complete and deployed. The app is usable for capture and for prep: items go in through quick-add or MCP, a meeting is prepped in one click from a person, a group, a series or a calendar event, and its agenda goes to Granola as a pasted brief. All three are deployed (`b90a30b`, pushed 2026-10-01; migrations `0001` and `0002` ran at boot).

- **Schema:** migration `0002` adds `series`, `series_people`, `series_projects`, `meetings`, `meeting_people`, `meeting_projects`, `meeting_dismissals`, `agenda_lines`, `connections`, `bindings`, and `origin_meeting_id`, `target_meeting_id`, `target_series_id` on `items`. `series_projects` is not in the spec's table list; the spec's "default projects" needed somewhere to live.
- **Domain:** `lib/meetings` (meetings, series, prep), `lib/agenda` (lines, schedule, candidates, generated blocks, brief, outline), `lib/connect` (connections, bindings, Google OAuth and calendar client), `lib/calendar/feed.ts`.
- **Screens:** `/meetings` (upcoming from the calendar and by hand, undated, past), `/meetings/[id]` (agenda editor with timing, suggestions, generated blocks, copy brief, copy agenda, sessions), `/series` and `/series/[id]` (next, roster, projects, skeleton, block defaults, history), `/settings` (Google connection, calendar-to-context binding), "Raise at" on the item page, Prep on person and group pages, meetings sections on the three hubs, "Next up" on home.
- **MCP:** adds `list_meetings`, `get_meeting`, `prep_meeting`, `update_meeting`, `set_agenda`, `edit_agenda`, `get_briefing`, `list_series`, `create_series`, `update_series`; `capture_item` and `update_item` take `target_meeting` or `target_series`. A meeting is named by id only (titles are not unique).
- **Tests:** 294 passing in 19 files. `test/candidate-rules.test.ts` holds the spec's Verification cases for candidates, leaks and context isolation; `test/prep.test.ts` holds the phase 2 walkthroughs (sporadic, routine 1:1).
- **Browser check:** every phase 2 screen was walked with Playwright against a production build, in light, dark and at phone width, with the server in UTC and the user in America/Chicago.

## Not verified

- **Google is connected on the deployed instance.** John connected several Google accounts on 2026-10-01 with no issues. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in Dockhand. `CONNECT_KEY` falls back to `SESSION_SECRET`, so rotating that one would orphan the stored tokens.
- **The calendar-event paths in the UI** (Prep from an event, attach a stub, make a series) were never clicked during the build, because there is no feed locally, and John has not yet reported on them. The functions under them are tested and the card renders on `/design`. Token refresh after the first hour is likewise covered by tests only.
- **"Since last time"** has tests but was not seen in a browser.

## Open with John

- **`@me` on a topic** makes John the owner (carried over from phase 1; confirm).
- **A 1:1 places only `with` items.** `Q: … @bishop` in the top-bar quick-add makes the bishop the owner, so it is suggested in his 1:1, one click away, rather than placed. Captured from his page it is `with` and places itself. The spec says `with`; say if owner items should place themselves in a 1:1 too.
- **Project suggestions include items raised with people who are not attending.** That is the spec's rule (project match). It may want narrowing.
- **The brief marks kinds as `[question, Sarah]`,** not `Q:`, because `Q:`/`A:`/`D:` lines in Granola's notepad are parsed as new captures in phase 3.
- **`users.time_zone` cannot be set in the app.** It is null, so everything uses the process `TZ` (compose sets America/Chicago). A field on Settings is small.
- **Quick-add no longer disables while saving** (a disabled submit swallowed Enter on fast entry). A tab closed within a moment of Enter could lose that line.
- **Settings is linked twice,** from the context switcher and the account menu.
- **Nothing can be deleted or archived** except meetings and series: people, groups, projects, contexts and items still have no removal, and a person entered twice cannot be merged.
- **Granola probe not run.** `scripts/granola-probe.ts` needs `GRANOLA_API_KEY` in the local environment.

## How the calendar feed behaves

Settled with John on 2026-10-01; revisit only if it becomes a problem.

- **It is a feed, not an import.** Nothing from Google is stored until Prep is pressed on an event. Connecting a calendar creates no meetings.
- **No history.** The feed asks for the next 14 days from the current hour. A past event that was never prepped leaves no trace, and there is no way to pick a past calendar event. Phase 3's "Log a meeting" and Granola notes that create their own meeting are the intended route; attaching a note to a past calendar event would need a look-back window in the feed.
- **Clutter dropped:** working locations, focus time, out of office and birthdays (by Google's `eventType`), events John declined, cancelled events, all-day events, rooms as attendees, and the same event seen on two bound calendars.
- **Clutter that gets through:** ordinary events John made as blocks ("Lunch"), events with no other attendees (kept on purpose: in-person 1:1s often have none), and events marked free. A "hide this event or its series" action would need one small table; not built.
- **Several accounts, several calendars.** Each calendar binds to exactly one context; a context can have many. A calendar that mixes two contexts cannot be split.

## Phase 3 scope (from the spec's build order)

Log a meeting with pasted notes first; then Granola ingest, reconcile job, extraction, review screen, recap export. The result closes the loop.

Suggested order:

1. **Schema:** `notes`, `processing_runs`, `proposals`, `documents`, `integration_events`.
2. **Log a meeting:** pick people, paste notes, run processing. No Granola needed, and it is the fallback if Granola fails.
3. **Verbatim lines by code:** `D:` `Q:` `A:` `T:` lines parsed before the model runs. `lib/items/capture.ts` has the prefix parser.
4. **Extraction** as a background job (`lib/jobs/scheduler.ts` lifts from Meeter), with fingerprints and remembered rejections.
5. **Review screen:** accept, edit, reject, approve all, undo. Low-confidence owners highlighted and excluded from approve-all.
6. **Granola ingest:** webhook, folder bindings (the `bindings` table already takes a `kind`), reconcile job, drop-ins with no calendar match.
7. **Recap export,** which obeys the same leak rule as follow-ups: only items placed on the agenda or originating in the meeting.

## Model rules to hold on to

The phase 1 rules still stand (one `items` table in four kinds; a decision is its own record; a question closes only with an answer; `parent_item_id` never moves; people are global and a context is a hard boundary for everything else). Phase 2 added:

- **John is never a row in `meeting_people` or `series_people`.** "Exactly two attendees" is a meeting with one row.
- **Placed without asking:** items aimed at the meeting; items aimed at its series, on the next occurrence only; in a 1:1, items `with` the other person.
- **Suggested:** matched through one of the meeting's projects or its group. In a 1:1, also what the other person owes.
- **Never offered:** person-only items in a larger meeting (they sit under "more"); anything matched only through John.
- **The leak rule:** follow-ups and "since last time" draw only from items on the agenda or originating in the meeting. The recap must do the same.
- **Taking an item's line off an agenda dismisses it** for that meeting, so automatic placement does not put it back. Placing it again clears the dismissal.
- **Automatic placement runs when a meeting is prepped and each time its page is opened,** until the meeting is over.
- **A stub is a meeting with no start.** Attaching it to a calendar event keeps the same row; `meetings.calendar_event_id` is unique, so an event cannot have two meetings.
- **A session is a meeting with a parent,** one level deep.
- **Blocks:** the meeting's own setting, else the series', else all off.
- **Outline minutes** are read only from the end of a title.

## Things learned

- **Subagents on the default model produced thin work in this repo:** placeholder screens, tests that asserted nothing, dead branches in the candidate rules, a refresh token overwritten with null. The same briefs run on the strongest model came back complete and found those defects. Anything touching the leak rules, credentials or a whole screen should go to the strong model, and its report should be read against the code.
- **Agents building in one directory clobber `.next`.** Copy `.next/standalone` and `.next/static` aside and run the server from the copy.
- **The feed cache hangs off `globalThis`,** because Next loads a module once per server layer and a clear from an action would otherwise miss the copy a page reads.
- **A disabled submit button swallows Enter.**
- **`Response.redirect` wants an absolute URL** in a Route Handler.
- The phase 1 notes still apply: React resets a form after its action; `showModal()` focuses the close button; no `setState` directly in an effect; Docker must be running for `pnpm test`; set `PUBLIC_BASE_URL` when the dev server is not on port 3000.
- **Password managers:** `Input` and `Textarea` opt out of autofill unless a field sets `autoComplete` itself. A raw `<input>` needs the same attributes by hand (see `QuickAdd`).
- **Browser checks:** still no Playwright in this repo; the walks used the one in `../Meeter/node_modules`. Adding it here with a small e2e suite is overdue.

## Local setup

```sh
docker start mm-dev-db   # or the `docker run` line in CLAUDE.md
pnpm install
pnpm db:migrate          # DATABASE_URL from .env.local
pnpm dev
```

`.env.local` is not committed; `.env.example` lists what it needs. The scratch databases `mm_verify_meetings` and `mm_verify_series` in `mm-dev-db` are left over from the browser walks and can be dropped.
