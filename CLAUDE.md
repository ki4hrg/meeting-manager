# Meeting Manager

A single-user tool for meeting prep, capture, post-meeting processing and per-project tracking. Granola is the live screen during meetings; this app holds everything before and after. The full design is in `docs/SPEC.md` — read it before changing the data model or workflow.

## UI rules

These apply to every screen.

- **Card-oriented, with clear visual hierarchy.** White cards on a grey page, grouped under section headers with the action on the right. The look follows `../Expense-Tracker`. A flat list of undifferentiated rows is the thing to avoid.
- **Minimal words.**
  - Don't narrate the UI or explain design choices on screen.
  - Let icons, colour, position and grouping direct the user instead of prose.
  - Labels are short and action-oriented ("Add", "New project", "Copy").
  - No helper paragraphs, no subtitles that restate the title, no explanatory empty states. An empty list shows its icon and the one action that fills it.
- **Kind, owner type and status are shown visually**, not with text labels: `KindIcon`, the person/group icon, `StatusBadge`.
- **Buttons** (issue #2):
  - **Blue (`primary`): at most one per screen**, the thing the page is for (Copy brief, Approve all, New project, Prep). A card in a list never has one.
  - **Gray (`secondary`)** for every other button with words, section adds included. **Red** only on the confirm inside a destructive dialog. **Ghost blue** only for a link that looks like a button (More, Earlier).
  - **Words always come with an icon** ("+ Add", "+ Section"). Label-only is for a modal's Cancel and Save.
  - **Icon only** (`IconButton`, `IconAction`, `FormModal compact`), with its label as tooltip: every action on a row or card, and a header's housekeeping in `PageHeader`'s `tools`, in this order: Edit (pencil), Move, Archive. Rows are gray, blue for the affirmative (Accept, Place), `on` for a toggle that is set.
  - **One shape per verb:** Edit is the pencil; Remove is the `close` `IconAction`; Delete is the trash, with a confirm; Restore is icon and label.
  - **"New X"** in a page header makes something that stands on its own; in a section titled for it, just "New". **"Add"** attaches something to the page.
- **One colour map.** Every tone comes from `components/ui/StatusBadge.tsx`. Don't invent a colour for a status inline.
- **Use the shared components** in `components/ui/` (`Card`, `LinkCard`, `Tile`, `Section`, `CardGrid`, `PageHeader`, `Field`/`Input`, `Modal`, `Button`, `EmptyState`, `Icon`, `IconButton`, `Chip`, `RemovableChip`, `CheckList`, `DueBadge`, `ProjectStatusBadge`) and `components/` (`FormModal`, `ActionForm`, `ActionButton`, `IconAction`, `ActionSelect`, `CopyButton`, `QuickAdd`, `ItemCard`/`ItemGrid`, `MeetingCard`, `Roster`/`GroupCluster`/`MeChip`) instead of repeating class strings. `/design` shows them all; add new shared pieces there.
- Every colour class has a `dark:` partner. Check new screens in light, dark and at phone width.

## Layout

- `app/(app)/` — signed-in pages. Authenticated by the layout; a new page here is safe by default.
- `app/(auth)/` — `/login` and `/setup` (creates the one account, then closes).
- `app/api/` — Route Handlers. **Not** guarded by placement; each authenticates itself.
- `app/oauth/`, `app/.well-known/`, `lib/oauth/` — the OAuth 2.1 server MCP clients sign in through.
- `lib/mcp/` — the MCP server. Tools are data in `lib/mcp/tools/`, registered in `allTools` in `server.ts`.
- `lib/db/schema.ts` — Drizzle tables. `lib/core/types.ts` — `Executor`, `ActorContext`, `AppError`.
- `lib/directory/` — contexts, people, groups, and `resolve.ts`, which turns a typed name into a row.
- `lib/projects/` — projects, milestones, links.
- `lib/items/` — `items.ts` (the item lifecycle and every item query), `capture.ts` (the quick-add line).
- `lib/meetings/` — `meetings.ts` and `series.ts` (CRUD), `prep.ts` (what turns a person, a series or a calendar event into a meeting with its agenda started).
- `lib/agenda/` — `lines.ts` (the agenda in the database), `schedule.ts` (start times), `candidates.ts` (what an agenda pulls in: the leak rules), `generated.ts` (follow-ups, since last time, lookahead), `brief.ts` (the paste for Granola and the public agenda), `outline.ts`.
- `lib/meetings/` also holds `log.ts` (Log a meeting: people and pasted notes) and `move.ts` (a meeting or series to another context).
- `lib/notes/`, `lib/processing/` — a meeting's notes, and what turns them into proposals: `verbatim.ts` (`D:` `Q:` `A:` `T:` lines, by code), `extract.ts` and `prompt.ts` (the model, behind the `Extractor` in `types.ts`), `run.ts` (queue and process), `proposals.ts` (accept, edit, reject, undo). `lib/documents/` — documents a meeting produced.
- `lib/agenda/recap.ts` — the recap, computed on demand under the leak rules.
- `lib/jobs/` — the scheduler and its jobs (`process-notes`, `granola-reconcile`), started from `instrumentation.ts`.
- `lib/connect/` — connections to outside services and their bindings; `lib/connect/granola/` — Granola's client, webhook, ingest and reconcile, and `unfiled.ts` (notes held in the Inbox until filed into a context); `lib/calendar/feed.ts` — the read-only Google Calendar feed.
- `lib/web/` — `context.ts` (the viewer and the selected context), `action.ts` (`act()`, the wrapper every server action uses).
- `app/(app)/actions.ts` — server actions for items, the directory and projects. `app/(app)/meetings/actions.ts`, `app/(app)/meetings/processing-actions.ts` (log, review, notes), `app/(app)/series/actions.ts` and `app/(app)/settings/actions.ts` hold their own areas'.
- `components/forms.tsx` — `ActionForm`, `FormModal`, `ActionButton`, `IconAction`. `components/items/` — `ItemCard`, `ItemGrid`, `PartyLine`. `components/meetings/` — the agenda card, a session's agenda, suggestions, blocks, meeting, event and unfiled-note cards, and the start/end fields. `components/series/` — the skeleton editor. `components/processing/` — the Log modal, proposal cards, the party picker, run state. `components/documents/` — the document card.
- `test/` — Vitest against a real Postgres (Testcontainers; Docker must be running).

## Commands

```sh
pnpm dev            # needs DATABASE_URL and SESSION_SECRET in .env.local
pnpm typecheck
pnpm lint
pnpm test
pnpm db:generate    # after changing lib/db/schema.ts
pnpm db:migrate
```

Local database: `docker run -d --name mm-dev-db -e POSTGRES_USER=mm -e POSTGRES_PASSWORD=mm -e POSTGRES_DB=mm -p 54329:5432 postgres:18-alpine`

## Conventions

- Domain functions take an `Executor` (database or transaction) so writes compose into one commit.
- Refusals a person should read are `ValidationError`/`AppError`; the MCP layer returns their message as content.
- Dates shown to the user or sent to Todoist are computed in the user's time zone, never UTC.
- Server actions go through `act()` in `lib/web/action.ts`: it authenticates, turns an `AppError` into a message for the form, and revalidates. A server action is a public endpoint; the layout does not guard it.
- Forms submit through `ActionForm`/`FormModal`, which keep what was typed when the action refuses.
- Pages get the user, John's person row and "today" from `viewer()`, and the selected context (the `mm_context` cookie) from `requireContext()`, both in `lib/web/context.ts`.
- Every item query takes a `contextId`. Nothing is listed across contexts.
- John is never a row in `meeting_people` or `series_people`; he is at every meeting. A 1:1 is a meeting with one row.
- An agenda's candidates and generated blocks come only from `lib/agenda/candidates.ts` and `generated.ts`. A change to either needs a case in `test/candidate-rules.test.ts`.
- A meeting row is created only by `lib/meetings/prep.ts`, `lib/meetings/log.ts` or by hand. Nothing creates meetings from the calendar on its own; a Granola note with no meeting to match makes one through `meetingFromNote` in `prep.ts`.
- A note with `meeting_id` null is unfiled: it has no context, nothing is run on it, and it is listed only in the Inbox. `meetingOf()` in `lib/notes/notes.ts` is how code that needs a note's meeting gets it.
- A meeting with sessions keeps its own start and end; its agenda is its sessions', and nothing is placed on it.
- Nothing processing proposes reaches `items`, `documents` or `meetings` until the proposal is accepted. No test calls a model or the network: tests pass a fake `Extractor` and a faked Granola.
- Much of `lib/oauth`, `lib/mcp` and `lib/auth` was lifted from `../Meeter`; that repo is the reference for the integrations still to come (Granola, Todoist, Google Calendar).

## Deploy

GitHub Actions builds the image and pushes it to GHCR, then calls the Dockhand webhook. `compose.yaml` only pulls (`pull_policy: always`, no `build:` block).
