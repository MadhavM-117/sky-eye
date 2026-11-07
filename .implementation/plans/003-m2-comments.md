# 003 — M2 Comments — plan

Spec: §12 (comments & anchors), §15 (identity), §17 (deep links), §10 (API
contract), §21 M2. Pierre notes: `.implementation/docs/pierre-packages.md`
(annotation framework + selection API facts).

**Status: approved. Composer design A (inline annotation rows) signed off by
the user — 2026-11-06. Multi-line gutter selections open the composer at the
range's start line; any comment is editable (no ownership notion in v1).**

## Scope

Server (zero-dep, pure logic where possible):

1. `src/identity.ts` — resolve once, cache in memory:
   `jj config get user.name` / `user.email`, falling through to
   `git config user.name` / `user.email` (verify jj errors → manual
   fall-through, spec §15 / D§11). Missing → `author: null` → "anonymous".
   Pure core (`authorFromConfig(jjOut, gitOut)`) fixture-tested; CLI spawn at
   the boundary.
2. `src/anchors.ts` (new, pure) — anchor extraction given the file's lines:
   pinned `text` + up to 3 `before` / 3 `after` lines (spec §12). Fixture
   tests cover hunk boundaries (line 1, last line, short files).
   Caller: comment create / reanchor in `store.ts` — reads the file at
   `head` (new side) or `base` (old side) via `tree.ts readFileAt`; falls
   back to the chapter's hunk lines when the file isn't readable (spec §12).
3. `store.ts` — `createComment`, `patchComment` (shared conflict-checked
   write with `patchSession`): id = short random (`crypto.randomUUID`
   slice); `createdAt` = `updatedAt` on create; edits preserve `anchor` and
   bump `updatedAt`; `resolved: true` stamps `resolvedAt`, `resolved: false`
   clears it; `reanchor` recaptures a fresh server-side anchor and clears
   `orphaned`. `listSessions` openComments already works.
4. `routes.ts` — `POST /api/comments`, `PATCH /api/comments/:id` (X-Sky-Eye
   enforced by the server core already; 409 on `lastWriteAt` mismatch).

Frontend (all pierre contact through the adapter):

5. `pierre-adapter.js` — new pure `commentAnnotations(comments, composer)`
   projecting stored `Comment`s (+ an optional in-progress composer state)
   onto `DiffLineAnnotation`s (`{ side: 'deletions'|'additions', lineNumber,
   metadata }`). Fixture-tested (upgrade smoke test per the guide).
   `createFileDiff` grows: `renderAnnotation` callback (builds the comment /
   composer DOM node from metadata), re-set via `setLineAnnotations()` on
   every state change — full re-projection, never mutation.
   Gutter clicks: `onLineSelectionChange` already wired in M1 — app maps
   `SelectedLineRange` (+ `selectionSide()`) to (chapter, side, line) and
   opens the composer.
6. `app.js` — session view:
   - composer per the design below (pending sign-off);
   - comment display: author/anonymous, priority chip, text, resolve
     toggle, inline edit (PATCH text), copy-link; resolved comments collapse
     to a one-line summary, expandable (our UI, not pierre's);
   - header: open-comment count;
   - deep links: `#<sid>/<chapterId>/<file>/<line>` and
     `#<sid>/<commentId>` (§17), copy affordance on hover, on-load
     scroll + flash; parseHash extended (path percent-encoded).
7. `style.css` — app-chrome styling for composer + comment rows only
   (annotation rows live inside pierre's shadow DOM — check whether the
   `renderAnnotation`-returned node can be styled from the document
   stylesheet; if not, inline styles / adoptedStyleSheets on the returned
   element).

## Composer design (proposal — check in)

- **Open:** gutter click on a diff line → inline composer rendered as an
  annotation row directly below the clicked line (GitHub style), on the
  clicked side.
- **Fields:** textarea (autofocus, placeholder "leave a comment"),
  priority select (`normal` unset / `nit` / `must-fix`), Cancel + Comment
  buttons; Ctrl/Cmd+Enter submits, Escape cancels; only one composer open at
  a time; clicking another line moves it.
- **Comment display:** annotation row under the line — author (or
  "anonymous"), relative time, priority chip, text. Actions: resolve /
  reopen, edit (inline textarea, save/cancel), copy deep link.
- **Resolved:** one-line collapsed summary ("✓ resolved — <first line>"),
  click to expand; reopen available when expanded.

## Test plan (spec §20)

- `tests/anchors.test.ts` — context extraction fixtures (edges, short files,
  old vs new side source lines).
- `tests/adapter.test.ts` — comment→annotation projection fixtures
  (open/resolved/orphaned/priority, composer state, line 0 not possible —
  comments are line-anchored).
- `tests/identity.test.ts` — pure fall-through logic with fake config
  output.
- `tests/integration.test.ts` — real repo + server: POST comment (anchor
  captured from VCS file, 3-line context even at hunk edge), PATCH
  text/resolved/priority/reanchor, 409 on stale `lastWriteAt`, unknown ids →
  404.

## Risks / notes

- Annotation DOM lives in pierre's shadow root — verify styling path early
  with a spike before building the full composer UI.
- Selection API reports ranges (multi-line); composer opens on the range's
  start line (v1: single-line comments; multi-line anchor is not in the
  schema).
- `renderAnnotation` receives metadata we define — keep metadata as
  plain {kind: 'comment'|'composer', comment|composerState} payloads, not
  pierre shapes, per the adapter rule.
- Old-side (deletions) annotations confirmed working at 002.
- Deep-link line targets the annotation DOM node for scroll/flash
  (`onPostRender` or query inside `el` shadow root; verify at spike).
