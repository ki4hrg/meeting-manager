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
- **One colour map.** Every tone comes from `components/ui/StatusBadge.tsx`. Don't invent a colour for a status inline.
- **Use the shared components** in `components/ui/` (`Card`, `LinkCard`, `Tile`, `Section`, `CardGrid`, `PageHeader`, `Field`/`Input`, `Modal`, `Button`, `EmptyState`, `Icon`, `DueBadge`, `ProjectStatusBadge`) and `components/` (`FormModal`, `ActionForm`, `ActionButton`, `QuickAdd`, `ItemCard`/`ItemGrid`) instead of repeating class strings. `/design` shows them all; add new shared pieces there.
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
- `lib/web/` — `context.ts` (the viewer and the selected context), `action.ts` (`act()`, the wrapper every server action uses).
- `app/(app)/actions.ts` — every server action.
- `components/forms.tsx` — `ActionForm`, `FormModal`, `ActionButton`. `components/items/` — `ItemCard`, `ItemGrid`, `PartyLine`.
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
- Much of `lib/oauth`, `lib/mcp` and `lib/auth` was lifted from `../Meeter`; that repo is the reference for the integrations still to come (Granola, Todoist, Google Calendar).

## Deploy

GitHub Actions builds the image and pushes it to GHCR, then calls the Dockhand webhook. `compose.yaml` only pulls (`pull_policy: always`, no `build:` block).
