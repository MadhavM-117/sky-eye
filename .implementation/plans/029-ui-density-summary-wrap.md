# Plan 029 — UI density, session summary, wrap/scroll toggle

Three user-requested changes, all frontend-only except doc updates:

1. **Full-screen UI** — the `.frame` currently caps content at 1200px; remove
   the cap so the UI uses the whole window.
2. **Top-level change summary** — show the whole session's change size
   (`N files · +x −y`) in the session header. A session-level *narrative*
   was requested but is **deferred** (user decision: stats only for now;
   the narrative needs a new `Session` field, prompt, pipeline step and
   merge rules — a later task).
3. **Wrap vs scroll for long lines** — default stays `scroll`; a UI toggle
   switches diffs to `wrap`. Pierre supports this natively via the
   `overflow: 'scroll' | 'wrap'` option (`BaseCodeOptions`,
   `tmp/pierre/packages/diffs/src/types.ts:437`).

Decisions confirmed by the user: repo-convention plan location; default
`scroll`; stats-only summary.

---

## Approach

All three changes live in `src/public/` (CSS + `app.js` + `pierre-adapter.js`)
plus one-line doc updates in `docs/ux.md`. No server changes, no schema
changes, no new dependencies.

### Change 1 — full width

`src/public/style.css:38`:

```css
/* before */
.frame { max-width: 1200px; margin: 0 auto; padding: 0 16px 48px; }

/* after */
.frame { max-width: none; padding: 0 16px 48px; }
```

`margin: 0 auto` becomes a no-op at full width and can go. Everything
(first screen, session view, explorer) sits inside `.frame`, so one rule
covers all views. Pierre diffs size to their container; the explorer tree
(`.pierre-tree`, `height: 70vh`) also just gets wider. No other rule
references the 1200px cap.

### Change 2 — session summary in the header

**Stats are already computable client-side**: `chapterStats(c)` in
`app.js:266` sums `+x −y` over a chapter's file slices. The session total is
the sum over `session.chapters` — no server round-trip, no schema change.

In `app.js` next to the existing helpers:

```js
// session-wide change size for the header summary (sum over chapters;
// distinct paths — a file conceptually belongs to one chapter, but don't
// double-count if re-chunking ever splits one across chapters)
const sessionStats = (session) => {
  const files = new Set();
  let add = 0, del = 0;
  for (const c of session.chapters) {
    const [n, a, d] = chapterStats(c);
    for (const s of c.files) files.add(s.file);
    add += a; del += d;
  }
  return [files.size, add, del];
};
```

Render it in the **context row** of the session header
(`renderSession`, `app.js:307-332`) — row 2 already answers "what is under
review", and the change size belongs with the branch comparison:

```html
<div class="h-row h-context">
  <span class="repo-path" ...>…</span>
  <span class="meta">… → …</span>
  <span class="meta">${files} files · <span class="add">+${add}</span> <span class="del">−${del}</span></span>
</div>
```

Reuse the existing `.add` / `.del` color classes (already styled via
`--added` / `--deleted`, see `.rail-meta`). Keep the existing
`statsHtml(add, del)` helper where the −0/+x collapsing matters; for the
header, plain markup matching the rail's format (`N files · +x −y`) is
fine — the rail already renders exactly this shape (`railHtml`,
`app.js:359`), so copy its markup for visual consistency.

### Change 3 — wrap/scroll toggle (default scroll)

**Adapter** (`src/public/pierre-adapter.js`, `createFileDiff` ~line 110):
accept and forward the option — pierre's `FileDiff` constructor takes it via
`BaseDiffOptions`:

```js
export function createFileDiff(file, hunks, {
  onSelectionChange,
  onSelectionEnd,
  onLineNumberClick,
  onGutterUtilityClick,
  renderAnnotation,
  annotations = [],
  marks = [],
  overflow = "scroll",          // ← new, pierre-native ('scroll' is pierre's default)
} = {}) {
  ...
  const fileDiff = new FileDiff({
    diffStyle: "split",
    theme: DEFAULT_THEMES,
    disableFileHeader: true,
    overflow,                    // ← new
    ...
  });
```

**State** (`app.js`, module scope next to `railCollapsed` at line 30):

```js
let diffOverflow = "scroll"; // 'scroll' default (user decision); transient like railCollapsed
```

**Toggle button** in the session header **actions row** (row 3, alongside
mark reviewed / files / export — it is a primary view control, not a
"more"-menu item):

```html
<button id="wrap-toggle" title="${diffOverflow === "wrap"
  ? "long lines scroll horizontally — click to wrap instead"
  : "wrap long lines (comments are hidden while wrapped — click to switch back)"}">${diffOverflow === "wrap" ? "scroll" : "wrap"}</button>
```

The label shows the mode you'd switch *to* (mirrors how "full file" /
"diff view" labels work on the file bar).

**Pass-through** in `buildDiff` (`app.js:698`): add `overflow: diffOverflow`
to the `createFileDiff` call.

**Rebuild on toggle** (`wireSession`): the existing `restampMarks(chapter)`
(`app.js:819`) already contains the rebuild pattern — remove the instance's
element, drop it from the `diffs` map, call `buildDiff` again. Generalize it
into a rebuild over every mounted instance so the toggle rebuilds all of
them at once (a pure option change is not incremental in pierre here —
`createFileDiff` builds a fresh `FileDiff`, which is also how full-file mode
and re-runs already re-render):

```js
// rebuild every mounted diff with current options (wrap toggle, task 029);
// same pattern as restampMarks, applied to the whole diffs map
const rebuildAllDiffs = () => {
  for (const [key, inst] of [...diffs]) {
    const [chapterId, file] = key.split("\u0000");
    const chapter = current.chapters.find((c) => c.id === chapterId);
    const holder = inst.el.parentElement;
    inst.el.remove();
    diffs.delete(key);
    if (chapter && holder) buildDiff(holder, chapter, file);
  }
};
```

and in the wiring section (next to the other header buttons):

```js
document.getElementById("wrap-toggle")?.addEventListener("click", () => {
  diffOverflow = diffOverflow === "wrap" ? "scroll" : "wrap";
  rebuildAllDiffs();
  renderSession(current, route); // re-label the button; module state survives re-render
});
```

(`renderSession` re-render is safe here — the same pattern the rail toggle
avoids by mutating in place, but the diff rebuild already replaced every
diff element, so a full re-render is the honest, simplest path. If it
visibly flickers or loses scroll position, fall back to in-place button
re-label + `rebuildAllDiffs()` only — decide during implementation.)

**Known trade-off (documented, accepted):** pierre sets
`disableAnnotations: overflow === 'wrap'` (`FileDiff.ts:887`, `File.ts:706`)
— **comment annotation rows and the composer do not render while wrapped**.
The toggle button title says so. Marks are NOT annotations (gutter glyphs
stamped in `onPostRender`, task 009) and should keep working — verify on
first run: with `overflow: 'wrap'` pierre renders multi-row lines
(`rowCount`/`rowSpan` path, `FileDiff.ts:3306`), and `stampMarks` anchors to
`[data-column-number]` cells which still exist per logical line. If marks
misplace under wrap, that's a follow-up bug, not a blocker for this task.

Not done (named, skipped): persisting the wrap preference (transient like
`railCollapsed`; a `.sky-eye/config.json` key can come later if wanted),
per-file wrap toggles (one global toggle covers the need).

---

## File changes

| File | Change |
|---|---|
| `src/public/style.css` | `.frame` → `max-width: none` (drop `margin: 0 auto`) |
| `src/public/app.js` | `sessionStats()` helper + header context-row summary; `diffOverflow` module state; `overflow` in `buildDiff`'s `createFileDiff` call; `#wrap-toggle` button in header actions row + click handler; `rebuildAllDiffs()` helper |
| `src/public/pierre-adapter.js` | `createFileDiff` accepts `overflow = "scroll"` and forwards it to `new FileDiff(...)` |
| `docs/ux.md` | §3.1: context row carries the change summary (`N files · +x −y`); actions row carries the wrap/scroll toggle; note the wrap-mode comments-hidden caveat |

No changes: server (`src/*.ts`), `types.ts` (nothing stored), `esbuild`
config, tests for other areas.

## Tests

Per §20 (pure logic as fixtures; no CLUI/UI harness exists for the frontend
beyond `tests/adapter.test.ts`):

- `tests/adapter.test.ts`: `createFileDiff` now takes `overflow` — the
  existing constructor-options are otherwise untested (DOM-bound); nothing
  new is *pure* to fixture here. The only new pure logic is `sessionStats`
  — but it lives in `app.js`, which has no test entry today (adapter tests
  import from `pierre-adapter.js`). Two options:
  - **chosen:** put `sessionStats` in `pierre-adapter.js`? No — wrong home
    (it's session-level, not pierre projection). Instead leave
    `sessionStats` in `app.js` and cover it with one small fixture test by
    importing from `app.js` is not possible (app.js runs DOM code at import).
    **So: no new test file; verify manually** — the change is arithmetic
    reuse of `chapterStats` over an array, fully exercised by the rail's
    existing per-chapter use. Note this deviation from "new non-trivial
    logic leaves one test": `sessionStats` is trivial (a fold), the toggle
    is option plumbing, the width change is CSS.
- **Manual verification recipe** (hand-over):
  1. `node src/main.ts` in any repo with a session; UI spans the full
     window width at e.g. 2560px (no centered 1200px column).
  2. Header context row shows `N files · +x −y`; totals match the sum of
     the rail's per-chapter numbers.
  3. Default diffs scroll horizontally on a long line; click **wrap** →
     long lines wrap, no horizontal scrollbar; click **scroll** → back.
  4. While wrapped: comments/composer rows are absent (expected, button
     title says so); attention-mark glyphs still sit in the gutter.
  5. Toggle in full-file mode and with an open composer → no crash; after
     toggling back, comments reappear (rebuild re-projects annotations).
  6. Re-render paths still work after a toggle: comment a line, mark a
     chapter viewed, re-run a chapter.

## Considerations / trade-offs

- **Pierre-native `overflow` vs CSS hack** (`white-space: pre-wrap` on code):
  the CSS hack breaks pierre's virtualization measurements (row heights) and
  column alignment — pierre's wrap mode handles `rowCount`/`rowSpan`
  internally. Native option wins decisively.
- **Rebuild-all vs `updateOptions`**: pierre can diff options between
  renders (`CodeView.ts:4486` compares `overflow`), so an in-place
  `render({ ... options })` *might* work — but sky-eye's adapter owns no
  post-construction option updates today, and every existing re-render path
  (full-file, restamp) rebuilds instances. Rebuilding keeps one pattern;
  trying the cheap in-place update first and falling back to rebuild is a
  fine implementation order.
- **Summary placement**: context row (with repo/branches) rather than
  actions row — it's information, not an action; the rail already repeats
  per-chapter numbers, the header now answers for the whole change.
- **Session narrative deferred**: keeping it out avoids schema change
  (`Session.summary`), a new LLM prompt + pipeline step, PATCH/edit flow,
  and export/import merge rules. When picked up later, `ux §3.1` and spec
  §10/§14/§16 are the touch points.

## Dependencies

None. No new packages, no migrations, no config keys.

## Process notes (for task pickup)

- Create `.implementation/tasks/029-ui-density-summary-wrap.md` when
  picking this up (numbers = execution order; nothing pending sits after
  028 that would conflict).
- Doc updates belong in the same change (process.md: reality follows docs).
- Learnings candidates: pierre `overflow: 'wrap'` disables annotations;
  rebuild-vs-options-update behavior of `FileDiff`.

---

## Todo

### Setup
- [x] Create `.implementation/tasks/029-ui-density-summary-wrap.md`

### Change 1 — full width
- [x] `style.css`: `.frame` → `max-width: none`, drop `margin: 0 auto`

### Change 2 — session summary
- [x] `app.js`: add `sessionStats()` helper next to `chapterStats`
- [x] `app.js`: render `N files · +x −y` in the header context row

### Change 3 — wrap/scroll toggle
- [x] `pierre-adapter.js`: `createFileDiff` accepts `overflow = "scroll"`, forwards to `FileDiff`
- [x] `app.js`: `diffOverflow` module state + pass `overflow: diffOverflow` in `buildDiff`
- [x] `app.js`: `rebuildAllDiffs()` helper (generalize the restampMarks rebuild loop)
- [x] `app.js`: `#wrap-toggle` button in header actions row + click handler

### Docs
- [x] `docs/ux.md` §3.1: context-row summary, actions-row wrap toggle, wrap-mode caveat

### Verify & check in
- [x] `tsc --noEmit` + esbuild bundle + `node --test` pass (188/188)
- [x] Manual recipe from the plan — partially: bundle/content checks done
  programmatically (`wrap-toggle` in dist, 1200px gone, totals reuse the
  rail's markup path); **browser interaction steps remain for the user**
  (toggle both ways, marks under wrap, comments restored after toggling back)
- [x] jj commit (conventional message) — `feat(ui): full-width layout, header change summary, wrap toggle` (ryuuntpy)
- [x] Learnings entry (pierre wrap disables annotations) — `.implementation/learnings/pierre-diffs.md` + index

### Follow-up fixes (user feedback, same task)
- [x] Mark glyphs top-aligned (`pierre-adapter.js` `markGlyph`): absolute
  `top:0` instead of `inset-block:0` + centering, so a wrapped/annotation
  row's tall cell keeps the glyph beside the line number. Pixel-offset
  refinement after screenshot feedback: no flex/padding at all — the span
  inherits the cell's line-height and centers on the first line box like
  the number does.
- [x] Header summary colorized: `.add`/`.del` color rules made global in
  `style.css` (were scoped to `.stats`/`.rail-meta`; the header's `.meta`
  span was invisible-colored). Committed separately as `swpunkzo`.

### Deviations from the plan
- Toggle handler re-labels the button **in place** instead of re-running
  `renderSession`: the plan's fallback option. `renderSession` mid-session
  would re-run `wireSession` and drop the composer's half-written draft —
  in-place keeps it. Existing mid-session re-renders (rerun-all, re-chunk)
  already accept that loss; a mere view toggle should not.
- `sessionStats` got no unit test (plan §Tests explained why: `app.js` has
  no importable test entry — DOM code runs at import). Manual recipe step 2
  covers it (totals must match the rail's sum).
