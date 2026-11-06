# Working with the `@pierre/*` packages

Practical guidance for the external dependencies adopted in spec §2
(decision: frontend-only, server stays zero-dep). Read this before any task
that touches the frontend renderer. Task plans should extend this file, not
replace it — add learned API details and gotchas as they surface.

## What we depend on, and where the truth lives

| Package | Version basis | Role in sky-eye |
|---|---|---|
| `@pierre/diffs` | 1.6.4 (stable, active 1.x) | `FileDiff` (split/unified two-column diff), `File`/`CodeView` (explorer file view), `VirtualizedFileDiff`/`VirtualizedFile` (large diffs), line-annotation framework (comments 002, marks 005), selection API (gutter clicks) |
| `@pierre/highlights` | 0.4.0 | 152-language WAT/WASM highlighter; used *indirectly* — diffs renders with it; we don't call it directly in v1 |
| `@pierre/trees` | 1.0.0-beta.6 (beta) | `FileTree` class for the explorer's tree navigation (search, git-status badges) |
| `@pierre/theme` | 2.0.0 (transitive) | The Pierre theme for Shiki; drives diff/file coloring |

Two sources of truth, in this order:

1. **npm dist** — what we actually build against. Pin **exact** versions
   (no `^`); bump deliberately with tests + manual checks, never
   transitively. `@pierre/diffs` is actively developed; assume minor
   versions change APIs.
2. **Vendored source at `tmp/pierre/packages/`** — the upstream monorepo
   clone, for *reading* API details, options, and tests (`diffs/test/`,
   `trees/test/`). Treat as read-only reference; never build against it,
   never edit it. If a docstring disagrees with the dist behavior, the dist
   wins. The packages also have runnable demos (`moonx demo:dev` upstream)
   and a docs site (diffs.com) — use them when the vendored source is
   unclear.

Version pinning note: `@pierre/trees` and `@pierre/path-store` are beta; if
trees blocks a task, fall back to our pre-008 hand-rolled tree rendering
(keep it in git history; restore with `jj restore`) rather than pinning a
moving beta in a hurry.

## The adapter rule

**Exactly one module — `public/pierre-adapter.js` — imports from
`@pierre/*`.** Everything else in `public/` is vanilla ES modules speaking
sky-eye's shapes (`Session`, `Hunk`, `DiffLine`, `LineMark`, `Comment`).

Why: pierre churns APIs (1.x); the adapter is the single place that breaks
on an upgrade and the single place version-diff reviews. Corollaries:

- The adapter is a **pure projection**: server JSON in → render input out;
  pierre events back → app actions out. No app state stored inside pierre
  model objects.
- Re-render after any server state change (refresh, comment resolve,
  re-pin) by **re-projecting the full annotation set** — don't mutate
  pierre model state incrementally. Pierre's annotation code compares by
  value (`areLineAnnotationsEqual` et al. in `diffs/src/utils/`), so
  wholesale replacement is safe and idempotent; incremental mutation is
  where stale-render bugs live.
- Sky-eye never persists anything pierre-shaped. The session file stays
  pierre-agnostic (this is why export/import, 006, has no pierre surface).

## Build pattern (esbuild)

- `esbuild.config.mjs` bundles `public/app.js` (and the explorer entry if
  split) → `public/dist/`; the server serves `public/dist/` statically.
  Server code is untouched — Node type stripping, no bundler.
- CSS: pierre ships `style.css` (diffs) and editor CSS; import them in the
  bundle (esbuild CSS output) or copy to `public/dist/` — pick one, don't
  hand-copy pierre CSS into `style.css`. Our `style.css` keeps only app
  chrome; diff/tree internals are styled by pierre's classes + the theme's
  CSS custom properties.
- `@pierre/highlights` initializes WASM at import. Verify at task 008 how
  the dist loads its `.wasm` (inlined vs. fetched asset) and configure
  esbuild asset handling accordingly — this is the most likely bundling
  surprise.
- Bundle size will be large (shiki + WASM, likely ~1MB+). Acceptable:
  local-only tool. Don't add code splitting for it.

## Per-package crib sheet

### `@pierre/diffs`

- `FileDiff` takes structured hunk/line data (its own `Hunk`/`Line` shapes
  with old/new line numbers and line types — see `diffs/src/types.ts`), not
  unified-diff strings. Our `diff.ts` parser output maps onto it; the
  mapping lives in the adapter. Server-side parsing stays as specified
  (spec §7.2) — pierre does not parse diffs for us.
- Split is the default `diffStyle`; unified is an option. Sky-eye uses
  split (GitHub-style two-column, D§3 row 1).
- **Annotations** (`LAnnotation` generic on `FileDiff`): per-line injected
  content — this is how comments (002) and attention marks (005) render.
  Pierre's own review UI renders comments this way; read
  `diffs/test/annotations.test.ts` and `annotationHelpers.test.ts` for
  working patterns before designing ours.
- **Selection API**: gutter clicks / line selection for the composer and
  re-pin flows. Prefer its selection events over our own click handlers on
  rendered rows.
- `hunkSeparators` option controls inter-hunk rendering — chapter boundaries
  (§8) may map onto it; verify visually at 008.
- Virtualized variants exist for huge files (`VirtualizedFileDiff`) — the
  §22.5 decision at 004 is a component swap, not a project.
- React entries exist (`/react`, peer dep) — **we do not use them** (design
  §10 cut). Vanilla entry only.

### `@pierre/trees`

- `new FileTree({ paths, search, initialExpansion, ... })`, then
  `tree.render({ containerWrapper })`; mutate via `tree.add/move/remove/
  resetPaths`, query via `getItem/getSelectedPaths/getFocusedPath`.
- `tree.setGitStatus(entries)` — our changed-file badges (explorer links
  from chapters, U§2).
- **Renders inside a shadow root** — our CSS custom properties must be
  injected into that shadow root, not just the document; verify the mount
  options at 008 slice 4.
- State is keyed by canonical path strings; paths we feed must be
  repo-relative and normalized (matches our §11 containment rules — good).
- Call `tree.cleanUp()` when leaving the explorer view (it holds DOM +
  listeners).

### `@pierre/highlights`

- `codeToHtml(code, { lang, theme })` returns **UTF-8 bytes** (WASM memory)
  — decode before next call. Synchronous after import. (v1: only relevant
  if we ever call it directly; diffs does its own highlighting.)
- Themes: Zed-compatible; `@pierre/theme` is the bundled Pierre look.

## Integration facts (learned at task 008, diffs 1.6.4 / trees 1.0.0-beta.6)

- **Render input:** pass `render({ fileDiff: <FileDiffMetadata>, containerWrapper })`
  — not `fileContainer`. With `containerWrapper`, FileDiff creates its own
  `<diffs-container>` custom element whose shadow root carries the core
  component CSS; passing a plain div renders into an unstyled shadow root
  (empty-looking output, rows exist but no grid/colors).
- **Highlighter preload is mandatory:** `renderDiff` returns `undefined` and
  `FileDiff.render()` returns `false` until the shared highlighter is loaded.
  Adapter exposes `initPierre()` = `getSharedHighlighter({ themes: [light,
  dark], langs: [], preferredHighlighter: 'shiki-js' })`; `app.js` awaits it
  before first render. Language grammars lazy-load per diff and re-render on
  their own — don't preload them (and do pass `langs: []`, the shiki backend
  crashes on `undefined`).
- **WASM:** resolved — default engine is `shiki-js` (pure JS regex); the
  `highlights` backend and its `.wasm` are only reached via dynamic import,
  and the wasm ships pre-inlined as a JS module (`highlights.wasm.mjs`). No
  esbuild asset config needed.
- **Metadata path:** adapter re-serializes sky-eye hunks to unified-diff text
  (`patchText`) and runs the synchronous `parsePatchFiles` — pierre's parser
  computes all hunk bookkeeping (`hunkContent`, counts, split/unified
  offsets). Files need `new file mode`/`deleted file mode` lines or
  added/deleted parse as `change` (pierre has a contents heuristic fallback,
  but explicit mode lines are what real git emits). Git modes aren't stored
  server-side; fixed `100644` (header is disabled anyway).
- **Selection API:** `enableLineSelection: true` +
  `onLineSelectionChange(range | null)`, `SelectedLineRange.side` is
  `'deletions' | 'additions'`. Annotation hooks confirmed:
  `renderAnnotation` option + `setLineAnnotations()`, annotations are
  side-aware (`'deletions' | 'additions'`) — old-side comments render fine
  (002 unknown resolved).

## Integration facts (learned at task 002, diffs 1.6.4)

- **Gutter click → composer:** use `onLineNumberClick({ lineNumber,
  annotationSide })`, not the selection API — selection also fires while
  dragging to copy text; a gutter number click is the precise "comment here"
  signal. `selectionSide()` in the adapter accepts both shapes.
- **Rendering annotations:** pass `renderAnnotation(annotation) →
  HTMLElement` as a constructor option and the annotation array as
  `render({ lineAnnotations })`. Updates: call `render({ lineAnnotations })`
  with a *fresh array instance* — the identity check treats that as changed
  and re-renders annotation rows without rebuilding the diff.
- **One annotation per line:** pierre has no per-line stacking guarantee we
  can rely on; group all comments (plus an open composer) for a line into a
  single annotation whose metadata is `{ comments: [...], composer: null }`.
- **Annotation rows live in the LIGHT DOM:** `FileDiff.renderAnnotations`
  appends our `renderAnnotation` output as children of the `<diffs-container>`
  element and slots them into named `<slot>`s inside its shadow root. So:
  style them from the document stylesheet (style.css) — shadow-root
  `adoptedStyleSheets` do NOT reach them — and find them with a plain
  `container.querySelector` (adapter `queryComment`). The diff rows
  themselves (with `data-line`/`data-alt-line`) ARE inside the shadow root.
- **Deep-link targeting:** rendered rows carry `data-line` (own side's line
  number) and `data-alt-line` (other side's) inside `code[data-deletions]` /
  `code[data-additions]` blocks; our comment rows carry `data-comment-id`.
  `queryRow`/`queryComment` in the adapter find them; scroll+flash retries
  briefly because lazy grammar loading can re-render rows.
- **Hover copy-link (gutter utility):** the two APIs are mutually exclusive
  (pierre throws) — use `enableGutterUtility: true` + `onGutterUtilityClick(range)`
  and pierre's own default `+` button (shown on gutter hover). The callback
  receives a `SelectedLineRange`: plain click = single line, click-drag =
  range (that gesture also replaces plain gutter selection while enabled).
  `renderGutterUtility` (custom slotted element) would mean building our own
  button with no way to get the hovered line from it — don't.
- **Node-side test gotcha:** undici pools keep-alive sockets per origin; a
  socket from one `serve()` cycle breaks against the next server reusing the
  port ("other side closed"). Use `http.request` (no keep-alive) in
  integration tests when more than one server cycle runs.
- **Trees:** CSS ships in-bundle (no separate stylesheet export); theming
  via exported `themeToTreeStyles(resolvedTheme)` → CSS var string applied
  to the host element (`--trees-theme-*` chain resolves inside the shadow
  root). Shadow-root theming unknown resolved. Theme resolved through
  `@pierre/diffs` `resolveTheme('pierre-light')` so diff and tree agree.
  `FileTree` accepts `paths` (files only — dirs are derived), `search: true`,
  `initialExpansion: 'open'`, `gitStatus: [{path, status}]`,
  `onSelectionChange(paths)`; `scrollToPath(path)` for deep links;
  selection fires for dirs too — filter `path.endsWith('/')`.
- **esbuild:** `bundle + format esm + splitting true`. Without splitting,
  all shiki grammars inline → 12MB single file; with splitting the entry is
  ~540KB and grammars load as lazy chunks (server serves `dist/`
  statically). Minified.
- **Server gotcha:** `git ls-tree --end-of-options <ref> --` with a trailing
  `--` lists nothing (after `--end-of-options` the `--` is treated as a
  pathspec); the recursive listing omits it. The per-dir `gitTree` keeps its
  original form because a bogus `--` pathspec doesn't hide real matches.

## Testing pattern

- The adapter's mapping functions are **pure** — fixture-test them like the
  rest of our pure logic (spec §20): server JSON in, expected pierre input
  shapes out, using shapes transcribed from `diffs/src/types.ts`. These
  fixtures are also the upgrade smoke test: on a version bump, update
  fixtures from the new `types.ts` first.
- Component behavior (rendering, annotations, selection, shadow DOM) is
  integration/manual territory: each frontend task's acceptance includes
  the M1 manual recipe (both repo kinds, highlight + tree + annotation
  visible) plus the task's own additions.

## Upgrade procedure (when we bump a pinned version)

1. `npm install <pkg>@<exact>`; read the upstream changelog / diff the
   vendored source if it's been updated (`jj`-style: refresh the
   `tmp/pierre` clone to the matching tag).
2. Update adapter fixtures from the new `types.ts`; `npm test`.
3. Run the M1 manual recipe + the last task's acceptance recipe.
4. Commit the bump as its own change (`chore(deps): bump @pierre/diffs
   1.6.4 → 1.x.y`) so a bad bump is one `jj restore` away.

## Known unknowns (verify at first use — do not trust this list)

- ~~How `FileDiff` wants hunk context lines vs. changed lines modeled~~ —
  resolved: reconstruct the unified patch and let `parsePatchFiles` model it
  (above).
- ~~Whether annotations can span the old/new sides independently~~ —
  resolved: annotations are side-aware (`'deletions' | 'additions'`).
- ~~WASM asset loading shape under esbuild~~ — resolved: default engine
  needs none; wasm ships pre-inlined (above).
- ~~`FileTree` shadow-root theming injection point~~ — resolved:
  `themeToTreeStyles()` on the host element (above).
- `hunkSeparators` as chapter-boundary rendering — chapters are per-file
  `FileDiff` instances, so inter-hunk separators render inside each file;
  default `line-info` looks right. Revisit only if chapter boundaries ever
  need custom separator markup (M4 chunker tuning).
