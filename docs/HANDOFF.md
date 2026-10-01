# Handoff: start of phase 3

Written 2026-10-01 at the end of phase 2. Read `docs/SPEC.md` (the approved design) and `CLAUDE.md` (UI rules, layout, commands, conventions) first; this file only covers where things stand and what to do next.

## State

Phases 0, 1 and 2 are complete. The app is usable for capture and for prep: items go in through quick-add or MCP, a meeting is prepped in one click from a person, a group, a series or a calendar event, and its agenda goes to Granola as a pasted brief. All three are deployed (`b90a30b`, pushed 2026-10-01; migrations `0001` and `0002` ran at boot).

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
- **The meeting form takes a start and a length,** not an end time.
- **`users.time_zone` cannot be set in the app.** It is null, so everything uses the process `TZ` (compose sets America/Chicago). A field on Settings is small.
- **Quick-add no longer disables while saving** (a disabled submit swallowed Enter on fast entry). A tab closed within a moment of Enter could lose that line.
- **Settings is linked twice,** from the context switcher and the account menu.
- **Nothing can be deleted or archived** except meetings and series: people, groups, projects, contexts and items still have no removal, and a person entered twice cannot be merged.
- **Granola probe not run.** `scripts/granola-probe.ts` needs `GRANOLA_API_KEY`. Needed now.

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
