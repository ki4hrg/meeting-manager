# Handoff: start of phase 1

Written 2026-10-01 at the end of phase 0. Read `docs/SPEC.md` (the approved design) and `CLAUDE.md` (UI rules, layout, commands) first; this file only covers where things stand and what to do next.

## State

Phase 0 is complete and verified locally. The app is a signed-in, empty shell.

- **Sign-in:** `/setup` creates the one account and then closes; `/login`; sign-out from the account menu.
- **MCP:** OAuth 2.1 server (`lib/oauth`, `app/oauth`, `app/.well-known`) and a stateless endpoint at `/api/mcp`. One tool, `whoami`. Scopes are `meetings:read` and `meetings:write`; there are no roles.
- **UI foundation:** `components/ui/` (`Card`, `LinkCard`, `Tile`, `Section`, `CardGrid`, `PageHeader`, `Field`/`Input`/`Select`/`Textarea`, `Modal`, `Button`, `EmptyState`, `Icon`, `StatusBadge`, `KindIcon`) and `components/AppShell.tsx`. `/design` shows them all.
- **Schema:** only `users`, `sessions`, the three OAuth tables and `mcp_write_receipts`. One migration.
- **Tests:** 15 passing (`test/auth.test.ts`, `test/oauth.test.ts`, `test/mcp.test.ts`), against Postgres via Testcontainers.
- **Deploy:** `Dockerfile`, `compose.yaml`, `.github/workflows/deploy.yml` (check, image to GHCR, Dockhand webhook). The image was built and booted locally. No Dockhand stack exists yet, so the deploy job no-ops.

## Open with John

- **Look and colours not yet confirmed.** He has not said whether `/design` matches what he wants (kind colours: purple topic, amber question, blue action, green decision). Ask before building many screens on it.
- **Dockhand stack** not created: needs `POSTGRES_PASSWORD`, `SESSION_SECRET`, `PUBLIC_BASE_URL`, `APP_PORT`, the webhook URL and secret as repo secrets, and GHCR pull access for the host (the package is private on first push).
- **Granola probe not run.** `scripts/granola-probe.ts` needs `GRANOLA_API_KEY`. Needed before phase 3, not before phase 1.

## Phase 1 scope (from the spec's build order)

Contexts, people, groups, projects, milestones, links, items, events, quick-add, Inbox, the four hub pages, and `capture_item` over MCP. The result should be usable for capture.

Suggested order:

1. **Schema and migration:** `contexts`, `people`, `person_emails`, `groups`, `group_members`, `projects`, `milestones`, `project_links`, `items`, `item_parties`, `item_events`. Leave meetings, agenda, notes, documents, proposals and Todoist links for their phases. `items.origin_meeting_id` and the `target_*` columns can wait for phase 2, when `meetings` and `series` exist.
2. **Domain layer** in `lib/` (for example `lib/items`, `lib/directory`, `lib/projects`), each function taking an `Executor` and an `ActorContext`. Tests alongside.
3. **Context switcher** in the `AppShell` `switcher` slot; selected context kept in a cookie.
4. **Quick-add** in the `AppShell` `quickAdd` slot: one line, `@person` / `@group`, `#project`, optional kind prefix (`T:` `Q:` `A:` `D:`), everything optional.
5. **Screens:** Inbox, project hub, person page, group page, and the list pages that lead to them. Add each to `SECTIONS` in `app/(app)/layout.tsx` as it is built, and replace the placeholder tile on the home page.
6. **MCP:** `capture_item`, `list_items`, `update_item`, `convert_item`, plus people/group/project basics. Register in `allTools` in `lib/mcp/server.ts`; writes go through `lib/mcp/idempotency.ts`.

## Model rules to hold on to

These are the points the design turned on; the spec has the full reasoning.

- **One `items` table, four kinds.** Only `context` and `text` are required. Topic, question and action convert in place.
- **A decision is its own record with its own wording.** An answered question stays a question; "Record as decision" creates a linked decision pre-filled from the answer.
- **Action vs question is decided by what closes it:** information coming back makes it a question; a task being performed makes it an action.
- **`item_parties`:** a person or a group, role `owner` or `with`. On an item John owns, `with` is the party it is owed to.
- **Report back:** closing a question or recording a decision can spawn a child topic `with` another person or group.
- **People are global; contexts are a hard boundary** for projects, groups and items. One person row is marked as John.
- **`item_events`** logs every step, and the item page shows the whole thread through `parent_item_id`.
- **Statuses:** open, done, dropped; decisions: decided, superseded. `needs_answer` (already in `StatusBadge`) is for a question ticked off in Todoist with no answer; it arrives in phase 4.

## Things learned in phase 0

- **React resets a form after its action runs.** Return what was typed in the action's state and feed it to `defaultValue`, as `app/(auth)/actions.ts` does, or a validation error clears the form.
- **The React lint rule forbids `setState` directly inside an effect.** Read external state with `useSyncExternalStore` (see `components/theme-provider.tsx`) and close menus from click handlers, not from a pathname effect.
- **Expense Tracker has no card component or tokens to import;** its look was reproduced in `components/ui/`. Its `Button`, `Toast` and `ThemeToggle` were copied and keep its double-quote style; everything else follows Meeter's style (single quotes, no semicolons).
- **Docker Desktop must be running** for `pnpm test`.
- **`PUBLIC_BASE_URL`** defaults to `http://localhost:3000` in development. Set it in `.env.local` if the dev server runs on another port, or OAuth discovery advertises the wrong origin.
- **Browser checks:** there is no Playwright in this repo. Phase 0 was verified by driving the dev server with the Playwright installed in `../Meeter/node_modules`. Adding it here as a dev dependency with a small e2e suite would be reasonable in phase 1.
- **Unresolved:** the Next dev overlay once showed "1 Issue" after a theme switch immediately following an `.env.local` edit. It did not reproduce and nothing was logged.

## Lifting from Meeter later

The spec's "Stack and reuse" table says what lifts cleanly and what is a rewrite. Two corrections found during review: every integration client in `../Meeter/lib/connect` depends on an 888-line `connections.ts` that should be replaced with something small, and `copy-for-granola.tsx` lives under `app/(app)/meetings/[id]/agenda/`, not `lib/agenda`.

## Local setup

```sh
docker start mm-dev-db   # or the `docker run` line in CLAUDE.md
pnpm install
pnpm db:migrate          # DATABASE_URL from .env.local
pnpm dev
```

`.env.local` is not committed; `.env.example` lists what it needs. The dev database was emptied at the end of phase 0, so the first visit lands on `/setup`.
