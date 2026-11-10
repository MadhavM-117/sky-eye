# Plan 017 — Archive / delete a review

## Design decisions (spec §10 updated)

- Archive = `fs.renameSync` of the session file into
  `.sky-eye/archive/<id>.json`. Unarchive = rename back. Delete =
  `unlinkSync` of the active or archived file. All after `sessionId()`
  validation (traversal-safe, §9.2).
- Archived sessions are **not openable** (`loadSession` stays active-only):
  the archive list offers restore, not open. Keeps `writeSession` (which
  writes to the active dir) from resurrecting archived sessions.
- Listing: `GET /api/sessions?archived=1` → same header shape from the
  archive dir; the header cache is keyed by file path, so archived entries
  don't collide with active ones. Invalidate cache entries on move/delete.
- Export of an archived session 404s (reads via `readSessionRaw`, active
  dir) — restore first. Accepted.

## Change

- `src/store.ts`: `archiveSession`, `unarchiveSession`, `deleteSession`,
  `listSessions(root, archived)` (shared header extraction); invalidate the
  header cache on move/delete (path-keyed).
- `src/routes.ts`: `POST .../archive`, `POST .../unarchive`,
  `DELETE /api/sessions/:id`, `?archived=1` on the list route.
- `src/public/app.js`: session header — archive + delete buttons (delete
  confirms via `confirm()`); first screen — "n archived" expandable list
  with restore/delete buttons.
- `tests/integration.test.ts`: archive → gone from active list, present in
  archived list, load 404s → unarchive → active again → delete → gone.

## What could break

- `listSessions` currently `readdirSync`'s `.sky-eye/` non-recursively —
  subdirs never appear as `.json` files; no filtering needed.
- Import of an archived session's JSON would recreate it as active —
  acceptable (import is additive by design, §14).
