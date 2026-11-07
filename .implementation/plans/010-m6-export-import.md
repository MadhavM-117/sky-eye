# Plan — M6 Export/import (task 010)

**Goal:** export a session as a single JSON download; import + merge
(match by comment id, newer `updatedAt` wins, nothing deleted) + digest
re-verification + remap on mismatch (spec §14, routes §10).

## Current state

- No export/import routes exist. `routes.ts` has sessions/comments CRUD;
  `server.ts`'s `handle()` special-cases `{ status, value }` results into
  `sendJson` — no way to set a `Content-Disposition` or send a raw body yet.
- `store.ts` has atomic `writeSession`, `readSession` (private),
  `VALID_SESSION_ID` + `sessionId()` validation. Multi-file chapter schema
  check (pre-006 sessions rejected) exists in `loadSession`/`headerOf`.
- `remap.ts` exports `remapComments(root, kind, session)` — the §13.3 pass.
- First screen (`app.js` `renderFirst`) lists sessions; session header
  (`renderSession`) has reviewed toggle + files link. U§4 defers the
  export/import UI design to this milestone — designed below, minimal.

## Design

### Routes (spec §10 last two rows)

1. **`GET /api/sessions/:id/export`** — the session file *byte-for-byte*.
   `store.ts` gains `readSessionRaw(root, id)` (raw file text, 404 if
   missing, id validated). To send it verbatim, `server.ts`'s result
   protocol grows one field: `{ raw, headers? }` → `writeHead` with the
   given headers (default JSON content-type) and `res.end(raw)`. The route
   returns `{ raw, headers: { "content-disposition": 'attachment; filename="<id>.json"' } }`.
   No auth change: GET, Host check already applies.
2. **`POST /api/import`** — body IS the session JSON (readBody already
   parses it). Validation (§14): id format via `sessionId()`, shape check
   (chapters/comments arrays, same pre-multi-file rejection as
   `loadSession`), then merge.

### Merge (pure core, fixture-tested per §20)

`mergeSessions(local, imported)` in `store.ts` — pure, returns
`{ session, digestChanged }`:

- **Comments** matched by `id`: imported replaces local iff
  `imported.updatedAt > local.updatedAt`, ties (`===`) broken by older
  `createdAt` (the original wins); local-only comments stay — nothing
  deleted. Comment array keeps local order, replaced entries in place.
- **Narratives** matched by `chapter.id` (local chapters kept wholesale —
  they are diff-derived, not user state): imported narrative (and its
  `narrativeEdited` flag) wins iff local `!narrativeEdited`. A locally
  edited narrative is never overwritten — chapters carry no timestamp, so
  "imported updatedAt is newer" (spec §14) has nothing to compare and the
  safe direction is keep-local; noted in spec wording as "flag respected".
- **Digest check**: `digestChanged = imported.diffDigest !== local.diffDigest`
  (rebased clone on the other machine).
- If no local session with that id → import IS the new session
  (validate + `writeSession`; staleness check runs on open per §14).

`importSession(root, kind, body)` wraps it: validate → read/merge →
if `digestChanged`, run `remapComments` (the §14 "run the remap pass"
clause) → `writeSession` → return merged.

### Frontend (minimal, per U§3.1 + deferred-UI note)

- Session header: `<a href="/api/sessions/<id>/export">export</a>` —
  browser download via Content-Disposition, zero JS.
- First screen: `import` button + hidden `<input type=file>` → read text →
  `mut("POST", "/api/import", JSON.parse(text))` → jump to the merged
  session hash. Bad JSON → alert from the route's 400.

## Files

| File | Change |
|---|---|
| `src/server.ts` | result protocol: `{ raw, headers? }` branch (≈4 lines) |
| `src/store.ts` | `readSessionRaw`, pure `mergeSessions`, `importSession` |
| `src/routes.ts` | two new routes |
| `src/public/app.js` | export link in header; import button on first screen |
| `src/public/style.css` | (only if a style is needed for the import control — reuse existing buttons) |
| `tests/import.test.ts` | new: merge fixtures (newer-wins, tie, nothing-deleted, narrative rules, digest flag) + create-on-import via temp dir |
| `tests/integration.test.ts` | add export download round-trip + import merge through the real server |
| `docs/spec.md` | §14 narrative note (no timestamp → keep-local on locally edited); §10 route rows already accurate |

## Risks / open points

- Spec §14's "imported `updatedAt` is newer" for narratives can't compare
  anything (chapters have no timestamp) — implemented as "locally unedited
  → imported wins", the only safe reading; documented, not a deviation.
- `remapComments` on digest mismatch orphans all `old`-side comments (same
  as refresh); acceptable per D§6 cut ("old side is history").
- Import of a session that doesn't exist locally: created as-is; comments
  keep imported anchors — staleness/orphans surface on open via checkStale.
