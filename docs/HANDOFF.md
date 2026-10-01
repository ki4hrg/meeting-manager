# Handoff: start of phase 2

Written 2026-10-01 at the end of phase 1. Read `docs/SPEC.md` (the approved design) and `CLAUDE.md` (UI rules, layout, commands) first; this file only covers where things stand and what to do next.

## State

Phases 0 and 1 are complete. The app is usable for capture: items go in through quick-add or MCP and are read back on the Inbox and the project, person and group pages. Phase 0 is deployed; phase 1 is not yet.

- **Schema:** `contexts`, `people`, `person_emails`, `groups`, `group_members`, `projects`, `milestones`, `project_links`, `items`, `item_parties`, `item_events`, added by migration `0001`. `items` has no `origin_meeting_id` or `target_*` columns yet.
- **Domain:** `lib/directory` (contexts, people, groups, name resolution), `lib/projects`, `lib/items/items.ts` (lifecycle, queries, threads), `lib/items/capture.ts` (quick-add).
- **Quick-add:** `Q: what is the menu @sarah @tom #retreat`. Kind prefix `T:` `Q:` `A:` `D:`, any number of `@person`/`@group`, one `#project`, all optional. A name matches on a prefix of any word (`@sarah`, `@Sarah-Jones`); an unknown or ambiguous one is refused. A token at either end of the line is dropped from the text; one inside the sentence is replaced by the name.
- **Role rule in quick-add:** on a topic or decision, those named are `with`. On a question or action they are `owner`, unless `@me` is named, in which case John is the owner and the others are `with`. `@me` on a topic makes John its owner. A hub page's Add button passes its party and role as presets instead.
- **Screens:** home (tiles, "I owe", "Waiting on"), `/inbox`, `/projects` and `/projects/[id]`, `/people` and `/people/[id]`, `/groups` and `/groups/[id]`, `/items/[id]` (the item, its thread, its history, every lifecycle action), `/contexts`. The context switcher and quick-add (also the `N` key) are in the top bar.
- **MCP:** `whoami`; `capture_item`, `list_items`, `get_item`, `update_item`, `convert_item`; `list_contexts`, `create_context`, `list_people`, `create_person`, `list_groups`, `create_group`, `list_projects`, `create_project`, `update_project`. Names are accepted wherever an id is. `idempotency_key` is optional on writes.
- **Tests:** 46 passing in six files. Phase 1 added `test/items.test.ts`, `test/capture.test.ts` and `test/mcp-items.test.ts`.
- **Look and colours:** confirmed by John on 2026-10-01 (kind colours: purple topic, amber question, blue action, green decision).
- **Browser check:** every screen was walked through with Playwright in light, dark and at phone width against a production build.

## Open with John

- **`@me` on a topic** makes John the owner. A reviewer read the spec as wanting `with`. Left as built; confirm.
- **Nothing can be deleted or archived:** people, groups, projects, contexts and items have no removal. An item can be dropped. A person entered twice cannot be merged.
- **Migration `0001` runs on the next deploy** (the container migrates at boot).
- **The series hub** is the fourth hub in the spec and belongs to phase 2.
- **Granola probe not run.** `scripts/granola-probe.ts` needs `GRANOLA_API_KEY`. Needed before phase 3.

## Phase 2 scope (from the spec's build order)

Calendar feed, series, lazy meetings, stubs, sessions, candidate placement and suggestions, agenda editor with timing, generated blocks, outline import, brief for Granola. The result should be usable daily for prep.

Suggested order:

1. **Schema and migration:** `series`, `series_people`, `meetings`, `meeting_people`, `meeting_projects`, `meeting_dismissals`, `agenda_lines`; `items.origin_meeting_id`, `target_meeting_id`, `target_series_id`; the "discussed" item event.
2. **Meetings by hand first:** create a meeting or an undated stub, set people, projects and group, "Prep a meeting with…" from a person page. No calendar needed.
3. **Candidates:** the placed and suggested rules in the spec ("Agendas pull candidates"), with the tests in its Verification section written first. This is where a context or privacy leak would happen.
4. **Agenda editor:** sections and lines, free text or item reference, public text and private note, minutes and computed starts.
5. **Series:** roster, default projects, skeleton, generated-block defaults; the series hub.
6. **Generated blocks and the brief for Granola.** Outline import (`lib/agenda/outline.ts` lifts from Meeter).
7. **Google Calendar feed** last: connections, calendar-to-context binding, stub-to-event attachment.

## Model rules to hold on to

These are the points the design turned on; the spec has the full reasoning.

- **One `items` table, four kinds.** Only `context` and `text` are required. Topic, question and action convert in place, and only while open.
- **A decision is its own record with its own wording,** created with status `decided`. An answered question stays a question; "Decision" on its page creates a linked decision pre-filled from the answer. Superseding creates a new decision whose parent is the old one and marks the old one.
- **Action vs question is decided by what closes it:** a question closes only with an answer; a topic or action closes by being done.
- **Reopening clears the resolution;** the old answer stays in the history.
- **`item_parties`:** a person or a group, one role per party per item, `owner` or `with`. On an item John owns, `with` is the party it is owed to.
- **Report back:** answering a question or recording a decision can spawn a child topic `with` another person or group. It carries the question's text and the answer as its detail.
- **People are global; contexts are a hard boundary** for projects, groups and items. A person's page shows only the selected context. One person row is John (`is_self`), created from his account on first use.
- **`parent_item_id` is set at creation and never moved,** so a thread cannot loop. The item page shows the whole thread from its root.
- **The Inbox** is open items with no party and no project.
- **Statuses:** open, done, dropped; decisions: decided, superseded. `needs_answer` is in the enum and counts as open; nothing sets it before phase 4.

## Things learned

- **React resets a form after its action runs.** The auth forms return what was typed in the action state. Everything else submits by hand through `ActionForm` in `components/forms.tsx`, which leaves the fields alone when the action refuses.
- **A server action is a public endpoint.** Each goes through `act()` in `lib/web/action.ts`, which authenticates before doing anything.
- **`showModal()` focuses the close button.** `Modal` moves focus to the first field itself; React's `autoFocus` does not set the attribute the dialog looks for.
- **The React lint rule forbids `setState` directly inside an effect.** Read external state with `useSyncExternalStore` (see `components/theme-provider.tsx`) and close menus from click handlers, not from a pathname effect.
- **Expense Tracker has no card component or tokens to import;** its look was reproduced in `components/ui/`. Its `Button`, `Toast` and `ThemeToggle` were copied and keep its double-quote style; everything else follows Meeter's style (single quotes, no semicolons).
- **Docker Desktop must be running** for `pnpm test`.
- **`PUBLIC_BASE_URL`** defaults to `http://localhost:3000` in development. Set it in `.env.local` if the dev server runs on another port, or OAuth discovery advertises the wrong origin.
- **Browser checks:** there is still no Playwright in this repo. Next refuses a second `next dev` in one directory, so phase 1 was checked with `pnpm build` and `pnpm start -p 3111` against a scratch database (`mm_verify` in the `mm-dev-db` container), driven by the Playwright in `../Meeter/node_modules`. Adding Playwright here with a small e2e suite is overdue.

## Lifting from Meeter later

The spec's "Stack and reuse" table says what lifts cleanly and what is a rewrite. Two corrections found during review: every integration client in `../Meeter/lib/connect` depends on an 888-line `connections.ts` that should be replaced with something small, and `copy-for-granola.tsx` lives under `app/(app)/meetings/[id]/agenda/`, not `lib/agenda`.

## Local setup

```sh
docker start mm-dev-db   # or the `docker run` line in CLAUDE.md
pnpm install
pnpm db:migrate          # DATABASE_URL from .env.local
pnpm dev
```

`.env.local` is not committed; `.env.example` lists what it needs.
