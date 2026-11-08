# 023 — File-bar accordion behavior + full-file diff mode

## What changes

**Server (`src/remap.ts`, spec §13.3.5):** `remapComment` currently orphans a
comment whose re-anchored line matches content but lies outside every rebuilt
hunk. Change: re-pin it (`orphaned: false`) as an unchanged-line comment,
hosted in the first chapter that carries a slice for the file (the frontend
needs a chapter to mount the block in full-file mode). Only a failed content
match — or no chapter carrying the file at all (its change was fully
reverted) — orphans.

**Adapter (`src/public/pierre-adapter.js`):** new pure, fixture-tested
`fullFileHunks(hunks, fileLines)` — pads the stored hunks into ONE hunk
covering the whole file so the same `FileDiff` renders everything (changed
lines still marked). Gap lines come from the head file content (unchanged by
construction → emitted as ctx); old-side total derived exactly as
`newTotal − adds + dels`; added files keep `-0,0` header. Old/new counters
advance per line type, so numbering stays correct.

**Frontend (`src/public/app.js`, `style.css`, ux §3.2):**

- File bar: whole `<h3 class="file-head">` is the accordion toggle (click
  handler; the viewed checkbox/label and the full-file button are excluded).
  The path becomes plain text — `<a class="file-link">` removed. The chevron
  becomes a plain span indicator (the bar toggles, not the button).
- New full-file button on the bar (hidden for `deleted` slices — no head
  content to pad from). Toggling sets module-level `fullFileMode`
  (keyed `chapterId\0file`, reset on session switch like openOverrides),
  force-opens the block, fetches `/api/file?ref=<head>` (existing endpoint),
  pads via `fullFileHunks`, and rebuilds the holder's diff. Swap back
  rebuilds from the stored hunks.
- `buildDiff` grows an async branch: when the key is in full-file mode it
  fetches + mounts padded hunks (so a `renderSession` re-render — viewed
  PATCH etc. — keeps full-file mode). Falls back to diff view on fetch error.
- `annotationsFor` filters out unchanged-line comments when the block is in
  diff mode (their line isn't rendered; guarantees "visible only in
  full-file mode" and keeps pierre from seeing annotations on missing rows).
- Deep links (§17): line/comment targets whose line is outside the slice's
  hunks enable full-file mode + rebuild before scroll+flash (scrollFlash's
  retry loop covers the async fetch).

## What could break

- pierre annotation projection on non-rendered lines → filtered (above).
- Full-file mode lost on re-render → module-level Set + async branch in
  buildDiff keeps it across `renderSession` cycles.
- Deleted files have no head content → full-file button hidden, deep links
  fall back to diff view.
- Empty file (0 lines) → don't enter full-file mode (nothing to pad).
- Remap fixtures: the out-of-hunk test flips from orphaned → repinned; add a
  no-host-chapter orphan case.

## Testing

- `tests/remap.test.ts`: out-of-hunk → repinned (chapterId = host, not
  orphaned); no host → orphaned.
- `tests/adapter.test.ts`: `fullFileHunks` — modified file (gap fill +
  numbering), pure deletion hunk, added file (`-0,0` header).
- Existing suite green; integration round-trip untouched.
- Manual: live server in a tmp repo — bar click toggle, full-file toggle,
  comment on an unchanged line, jj refresh keeps it pinned.
