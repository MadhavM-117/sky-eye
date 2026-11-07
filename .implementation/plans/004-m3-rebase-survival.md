# 004 — M3 Rebase survival (plan)

## What changes

Server (new `src/remap.ts`, spec §13):

- `checkStale(root, kind, session)` — jj: rebuild diff, digest compare; git:
  resolve `headRef` via `git rev-parse`, compare to `session.head`; headRef
  missing / CLI failure → not stale. Returns boolean.
- `remapComment(comment, newLines, chapters)` — pure core (fixture-tested):
  exact `anchor.text` matches in new file lines; best candidate by weighted
  before/after context score, proximity as tiebreak; must fall inside a hunk
  of the rebuilt chapters for that file → re-pin (line, chapterId, fresh
  anchor); else orphan (`orphaned: true`, old anchor kept). Old-side
  comments orphan immediately. Missing file (`newLines: null`) → orphan.
- `refreshSession(root, kind, session)` — jj: rebuild diff + chapters in
  place, carry narratives by chapter id, remap, new digest, persist. git:
  resolve head → new id; equal → no-op; else create successor session
  (rebuild + remap + carried comments/narratives/label/aliases/reviewed),
  stamp `supersededBy` on the old one, persist both.

Wiring:

- `routes.ts`: `GET /api/sessions/:id` returns `{...session, stale}`; new
  `POST /api/sessions/:id/refresh` returns `{ session, supersededBy? }`.
- `store.ts`: export `persistSession` (was private `writeSession`).

Frontend (`app.js`, no new pierre surface — adapter stays idempotent):

- stale banner with refresh button; superseded banner deep-linking to the
  successor; orphan triage banner listing unresolved orphans with
  re-pin/resolve. Re-pin: click sets triage target, next gutter click on
  that file's diff sends `PATCH /api/comments/:id {reanchor}` (reuses the
  003 selection path), then clears triage.

## Files

- new: `src/remap.ts`, `tests/remap.test.ts`
- touched: `src/routes.ts`, `src/store.ts`, `src/public/app.js`,
  `src/public/style.css` (banner variants), `tests/integration.test.ts`
- docs: spec §22.1 (jj funcname verified — 0.46 emits funcname context),
  learnings

## Could break

- GET session now spawns a CLI (jj diff / git rev-parse) — slower GET;
  acceptable (single session view, not the list).
- Refresh replaces chapters wholesale → annotation projection must come from
  server state only (it already does; full re-render on refresh).
- Successor creation shares `VALID_SESSION_ID` safety; base is a 40-char id,
  new head a commit id — safe.

## Tests

- `tests/remap.test.ts`: single match, context-scored multi-match, nearest
  tiebreak, no match → orphan, out-of-hunk → orphan, old side → orphan,
  file gone → orphan.
- integration: git amend → stale → refresh supersedes (comments carried,
  re-pinned); orphan when the commented line is rewritten away; jj
  working-copy edit → stale → refresh in place (same id), digest updated.
