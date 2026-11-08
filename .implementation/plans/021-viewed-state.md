# Plan — Viewed state (files & chapters) + per-file accordion (task 021)

Spec refs: `docs/spec.md` §9.3 (`Chapter.viewedFiles`), §10 (PATCH
`viewedFiles`), §8a/§13.2 (viewed carry-over), §14 (not merged), §18 (UI);
`docs/ux.md` §3.2 (accordion + viewed toggles), §3.3 (rail glyphs).

**Status of the docs:** the spec/ux/design changes are already landed
(previous session). This plan implements them.

## Approach

Two state layers, deliberately different:

1. **Viewed = persisted**, stored per `(chapter, file)` slice as
   `Chapter.viewedFiles: string[]` (paths of slices marked viewed).
   "Chapter viewed" is **derived client-side** (`every` slice path listed) —
   never stored, so "mark all files → chapter viewed" and "mark chapter →
   all files viewed" are automatic and cannot desync. One PATCH field
   (`viewedFiles: { chapterId, files }`) covers all four toggles: the client
   always sends the full list for that chapter, the server intersects it
   with the chapter's slice paths.
2. **Collapse = ephemeral UI**, a module-level `Map<key, boolean>` (key
   `chapterId\0file`, same key format the `diffs` map already uses) holding
   an explicit open/closed choice per block. At render time:
   `hidden = open.has(key) ? !open.get(key) : isViewed(...)` — so a viewed
   file renders collapsed by default, marking viewed collapses immediately
   (`open.set(key, false)`), and unmarking viewed does NOT auto-expand
   (the explicit `false` survives). Not persisted; a new session id clears
   the map (fresh defaults).

No new endpoints, no dependency, no migration (field is optional; old
sessions read as "nothing viewed").

## Backend changes

### `src/types.ts` — add the field

```ts
export interface Chapter {
  id: string;
  files: FileSlice[];
  narrative: string;
  narrativeEdited?: boolean;
  title?: string; // one-line semantic description from the chunk task (§8a)
  attention: LineMark[];
  viewedFiles?: string[]; // slice paths marked viewed (spec §9.3); absent = nothing viewed
}
```

### `src/store.ts` — `patchSession` (§10)

Add one branch mirroring the existing `narrative` branch (404 on unknown
chapter, same conflict check already applies via `checkConflict`):

```ts
if (body.viewedFiles) {
  const v = body.viewedFiles as { chapterId?: string; files?: unknown };
  const chapter = session.chapters.find((c) => c.id === v.chapterId);
  if (!chapter) throw new ApiError(404, `unknown chapter: ${v.chapterId}`);
  const slices = new Set(chapter.files.map((s) => s.file));
  const files = Array.isArray(v.files)
    ? v.files.filter((f): f is string => typeof f === "string" && slices.has(f))
    : [];
  chapter.viewedFiles = [...new Set(files)]; // exact list; unknown paths dropped (§9.3)
}
```

`ApiError` is already imported in store.ts. `writeSession` bumps
`lastWriteAt`/`updatedAt` as usual — no other store change.
`mergeSessions` (import) stays untouched: viewedFiles is local progress,
like `reviewed` (§14) — chapters are diff-derived and never imported.

### `src/remap.ts` — carry viewedFiles by chapter id (§13.2, §8a)

`carryNarratives` is the single chapter-id carry used by jj refresh,
`createSuccessor` (supersede) and `rechunkSession`. Extend it and rename it
honestly (`carryChapterState`) — 3 call sites, all in this file:

```ts
export function carryChapterState(chapters: Chapter[], old: Map<string, Chapter>): Chapter[] {
  for (const c of chapters) {
    const prev = old.get(c.id);
    if (prev) {
      c.narrative = prev.narrative;
      if (prev.narrativeEdited) c.narrativeEdited = true;
      if (prev.viewedFiles?.length)
        c.viewedFiles = prev.viewedFiles.filter((f) => c.files.some((s) => s.file === f));
    }
  }
  return chapters;
}
```

(The filter is defensive — an unchanged chapter id means unchanged slices —
but costs one line and keeps the invariant "stored ⊆ slice paths".)

**No change to:** `routes.ts` (body flows through the existing PATCH
route), `analyze.ts`/`semantic-chunk.ts`/`chunker.ts` (new chapters are
born without viewedFiles — optional field), `api.js`.

## Frontend changes

### `src/public/app.js`

**Helpers + ephemeral open state** (module scope, next to
`activeChapterId`/`railCollapsed`, lines ~27–30):

```js
let openOverrides = new Map(); // key `chapterId\0file` → true=open, false=manually closed
const viewedKey = (chapterId, file) => `${chapterId}\u0000${file}`;
const isViewed = (c, file) => (c.viewedFiles ?? []).includes(file);
const chapterViewed = (c) => c.files.every((s) => isViewed(c, s.file));
```

In `renderSession`, reset per session and seed nothing (defaults are
derived at render time — see `diffHolderHtml` below):

```js
if (session.id !== activeSid) openOverrides.clear(); // fresh session → fresh collapse defaults
```

(place right where `activeSid`/`activeChapterId` are reconciled; `activeSid`
is already maintained there).

**`chapterHtml`** — per-file head becomes an accordion header with a viewed
checkbox; holder hidden by default when viewed:

```js
const blocks = c.files
  .map((s) => {
    const key = viewedKey(c.id, s.file);
    const open = openOverrides.has(key) ? openOverrides.get(key) : !isViewed(c, s.file);
    return `
    <h3 class="file-head">
      <button class="file-collapse" title="collapse / expand">${open ? "▾" : "▸"}</button>
      <a class="file-link" href="#${esc(session.id)}/explorer/${encodeURIComponent(s.file)}§head">${esc(s.file)}</a>
      <span class="status ${s.status}">${s.status}</span>
      <label class="viewed-toggle"><input type="checkbox" class="file-viewed"
        data-chapter="${esc(c.id)}" data-file="${esc(s.file)}"
        ${isViewed(c, s.file) ? "checked" : ""}/> viewed</label>
    </h3>
    <div class="diff-holder" data-chapter="${c.id}" data-file="${esc(s.file)}"
      ${open ? "" : "hidden"}></div>`;
  })
  .join("");
```

Chapter header gets the chapter-level toggle (after the stats span):

```js
<label class="viewed-toggle"><input type="checkbox" class="chapter-viewed"
  ${chapterViewed(c) ? "checked" : ""}/> viewed</label>
```

**`railHtml`** — read-only glyphs (ux §3.3): in the active row's file list
map, prepend `${isViewed(c, s.file) ? '<span class="viewed">✓</span>' : ""}`
before the status span; on the chapter row, prefix the title with
`${chapterViewed(c) ? '<span class="viewed">✓</span> ' : ""}`.

**`wireSession`** — one PATCH helper (follows the `patchComment` pattern)
plus handlers:

```js
const patchViewed = async (chapter, files) => {
  try {
    current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
      lastWriteAt: current.lastWriteAt,
      viewedFiles: { chapterId: chapter.id, files },
    });
    renderSession(current); // full re-render: rail glyphs, checkboxes, chevrons
  } catch (e) {
    handleMutError(e);
  }
};
```

- `.file-viewed` change → `openOverrides.set(viewedKey(chapter.id, file), false)`
  **before** `patchViewed` when checking (collapse immediately, ux §3.2);
  files = `checked`
    ? `[...new Set([...(chapter.viewedFiles ?? []), file])]`
    : `(chapter.viewedFiles ?? []).filter((f) => f !== file)`.
- `.chapter-viewed` change → `openOverrides` set to `false` for every
  unviewed slice key when checking (whole chapter collapses); files =
  `checked ? chapter.files.map((s) => s.file) : []`.
- **Force-open before scroll targets** (a hidden holder cannot be flashed):
  a small helper used by the three existing scroll paths —

```js
const forceOpen = (chapterId, file) => {
  openOverrides.set(viewedKey(chapterId, file), true);
  const h = [...document.querySelectorAll(".diff-holder")].find(
    (x) => x.dataset.chapter === chapterId && x.dataset.file === file,
  );
  if (h) { h.hidden = false; h.previousElementSibling?.querySelector(".file-collapse")
    && (h.previousElementSibling.querySelector(".file-collapse").textContent = "▾"); }
  return h;
};
```

  Use it in: the deep-link `route.target === "line"` branch and the comment
  branch (wrap `diffs.get(...)` lookups), the triage re-pin
  `scrollFlash(...)` call, and the `.rail-files li` click handler (an
  explicit navigation should reveal a viewed file).
- Re-render note: `renderSession` re-mounts all diffs (same as label edit /
  chapter nav today) — `openOverrides` survives it because it is
  module-level and only cleared on session change.

### `src/public/style.css`

- `.viewed-toggle` — same visual pattern as the header's
  `.reviewed-toggle` (muted, small, non-wrapping); inside `.file-head`
  it needs `margin-left: auto` so it right-aligns like the head's layout.
- `.file-collapse` — borderless button reset (like `#rail-toggle` styling),
  fixed width so the path column doesn't shift between ▾/▸.
- `.diff-holder[hidden]` needs no rule (`hidden` is default), but the
  `.file-head` already has flex styles (style.css:104) — extend, don't
  duplicate.
- `.viewed` glyph in the rail: `color: var(--muted)` (or the success-ish
  accent used elsewhere), `margin-right: 4px`.

## Considerations & trade-offs

- **Derived chapter-viewed vs stored boolean:** stored booleans can desync
  with the file lists they summarize; `every()` over ≤ a few slices is
  free and always true by construction. Spec §9.3 records this decision.
- **Full-list PATCH vs granular ops (`add`/`remove`/`all`):** one field,
  no op vocabulary, server stays a dumb validator (intersect + dedupe);
  last-writer-wins semantics stay simple with the existing `lastWriteAt`
  conflict check.
- **Eager mount + `hidden` vs lazy build:** diffs keep mounting eagerly
  (current behavior, §22.5 "chaptering is the virtualization" — plain
  `FileDiff` renders static rows, so a hidden mount is safe). *Verify this
  in the browser first*; if pierre mis-renders a hidden mount, fall back to
  lazy `buildDiff` on first expand (the holder keeps its data attributes,
  `refreshAll`/annotations already tolerate missing map entries).
- **Why not persist collapse:** the spec (ux §3.2) calls collapse "ephemeral
  (not persisted)" — viewed is the persisted intent, collapse is browsing
  state. One Map, no API traffic.
- **Unmark-viewed keeps the block closed** (explicit `false` override),
  matching the decision recorded in ux §3.2.
- **Explicitly out of scope:** auto-deriving session `reviewed` from
  chapters (stays manual, spec §9.3), merging viewedFiles on import (§14),
  rail-side toggling (glyphs are read-only).

## Tests (per §20 style)

1. **`tests/remap.test.ts`** — carryChapterState fixtures:
   - same chapter id → narrative AND viewedFiles carried (filtered to slice
     paths);
   - new chapter id (hunk ranges shifted) → viewedFiles dropped, narrative
     still carried when id matched — and absent when not;
   - chapter with no prior viewedFiles → field stays absent (not `[]`).
   Update the existing `carryNarratives` test name/imports for the rename.
2. **`tests/integration.test.ts`** — extend the existing temp-git-repo
   block (same pattern as the narrative-edit test):
   - `PATCH /api/sessions/:id { viewedFiles: { chapterId, files: [oneSlicePath] } }`
     → stored exactly; `GET` reflects it;
   - chapter-marked list (all slice paths) → stored; client derives
     chapter-viewed (`every`) — assert server stored the full list;
   - junk paths (`"../../etc"`, unknown file) dropped, duplicates removed;
   - unknown `chapterId` → 404; missing `lastWriteAt` conflict → 409
     (existing `checkConflict` covers it; one assertion for the new path);
   - old sessions without the field keep loading (no migration).

## Files touched

| File | Change |
|---|---|
| `src/types.ts` | `Chapter.viewedFiles?: string[]` |
| `src/store.ts` | `patchSession`: viewedFiles branch (404/intersect/dedupe) |
| `src/remap.ts` | `carryNarratives` → `carryChapterState` + viewedFiles carry (3 call sites) |
| `src/public/app.js` | open-overrides map, helpers, `chapterHtml` accordion heads + toggles, `railHtml` glyphs, `wireSession` handlers + forceOpen |
| `src/public/style.css` | `.viewed-toggle`, `.file-collapse`, `.viewed` glyph |
| `tests/remap.test.ts` | carry fixtures, rename |
| `tests/integration.test.ts` | PATCH viewedFiles round-trip block |

No new dependencies, no config, no migration.

## Verification recipe (manual, mirrors task 020's)

1. `node --run` test suite (or `node --test tests/`) green; `tsc --noEmit` clean.
2. Run `sky-eye` in `tmp/demo` (or any repo with a multi-file diff):
   - check a file's "viewed" → block collapses immediately, rail shows ✓,
     chapter checkbox flips when its last file is checked;
   - check the chapter's "viewed" → all file blocks collapse, all file
     checkboxes tick, rail chapter row shows ✓;
   - uncheck a file → chapter ✓ disappears, block stays collapsed;
   - reload → viewed files still collapsed; collapse an unviewed file and
     reload → it is expanded again (ephemeral);
   - deep-link to a line in a viewed file → block opens, scroll+flash works;
   - rail file click on a viewed file → opens + scrolls.
3. jj repo: touch a file, refresh → chapters with unchanged ids keep ✓;
   re-group (rechunk) with moved hunks → that chapter unviewed again.
4. Two tabs: edit viewed state in one, save in the other → 409 warning flow
   unchanged.

## Task-file note

Per repo convention the plan lives at
`.implementation/plans/021-viewed-state.md` with this file as the working
copy; the task entry is added to `.implementation/tasks/000-index.md`
(`021` — pending, after `019`; independent of `015`–`018`, no renumbering
needed since nothing here blocks them and they don't block it).
