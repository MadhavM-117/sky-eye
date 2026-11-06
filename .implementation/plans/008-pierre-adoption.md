# Plan — Task 008: Pierre adoption

**Task:** `.implementation/tasks/008-pierre-adoption.md` · **Spec:** §2 (deps), §18 (frontend arch), §19 (highlighting), §11/§10 (tree API)
**Accept:** M1 criteria (001 plan) driven by pierre rendering; no hand-rolled
highlight/diff code; `npm run build` bundles in one command.

## API facts learned from `tmp/pierre/packages/` (verify against npm dist)

- `FileDiff.render({ fileDiff, fileContainer })` — takes a `FileDiffMetadata`
  (pierre's parse output) **or** `{oldFile, newFile}` full contents. We have
  only hunk lines, so we go the metadata route.
- `parsePatchFiles(text)` — **synchronous**, node-safe (SSR guards), returns
  `ParsedPatch[]` with canonical `FileDiffMetadata` (all hunk bookkeeping:
  `hunkContent`, `splitLineCount`, `deletionLines`, …). Reconstructing that
  by hand is error-prone; instead the adapter **re-serializes sky-eye hunks
  to unified-diff text** (hunk headers are stored verbatim in `Hunk.header`)
  and lets pierre's parser build the metadata. Round-trip is lossless except
  `\ No newline at end of file` markers, which sky-eye never stored.
- Default highlighter is `shiki-js` (regex engine) — **no WASM asset**; the
  bundling surprise the doc feared doesn't apply. Styles are inlined into the
  bundle (`style.css?inline` → shadow-root `adoptedStyleSheets`); the npm
  packages export **no separate CSS** — esbuild needs no CSS-loader config.
- Selection API: FileDiff options `enableLineSelection` +
  `onLineSelectionChange(range: SelectedLineRange | null)`;
  `SelectedLineRange.side` is `'deletions' | 'additions'` → map to
  sky-eye `'old' | 'new'`. Annotation hooks confirmed for 002/005:
  `renderAnnotation` option + `setLineAnnotations()`; annotations can be
  per-side (`DiffLineAnnotation` has side info).
- `File` component: `new File({theme}).render({ file: {name, contents}, fileContainer })`
  for the explorer file view.
- `FileTree({paths, search: true, initialExpansion: 'open', gitStatus, onSelectionChange})`,
  `tree.render({containerWrapper})`, `tree.setGitStatus(entries)`,
  `tree.cleanUp()`. Tree CSS ships in-bundle; theming via exported
  `themeToTreeStyles(resolvedTheme)` → CSS string applied to the host
  element (its `--trees-theme-*` vars). Theme resolved through
  `@pierre/diffs`' `resolveTheme('pierre-light')` so diff + tree agree.

## Slices

1. **Deps + build** — done first: exact-pinned `@pierre/diffs@1.6.4`,
   `@pierre/trees@1.0.0-beta.6` (runtime), `esbuild` (dev).
   `esbuild.config.mjs`: bundle `src/public/app.js` → `src/public/dist/`
   (format esm, css extracted). `"build"` script. `index.html` points at
   `/dist/app.js` + `/dist/app.css`. Server static serving already covers
   `public/dist/` — zero server change.
2. **`public/pierre-adapter.js`** — the only `@pierre/*` importer:
   `patchText(file, hunks)` (pure), `fileDiffMetadata(chapter)` (pure,
   parsePatchFiles), `createFileDiff(chapter, {onSelectionChange})`,
   `createFileView(path, contents)`, `createFileTree({paths, changed, onOpen})`.
3. **Session view** — `app.js` renders per-chapter via adapter; delete
   `diffview.js` + `highlight.js`; strip diff-internals from `style.css`
   (keep chrome). Binary chapters (no hunks) keep the plain banner.
4. **Explorer** — `FileTree` (search + `setGitStatus` from session chapters)
   in existing breadcrumb/side-toggle chrome; file view via `File`; delete
   hand-rolled tree rendering.

**One server addition (additive, flagged for review):** `GET /api/tree`
gains optional `recursive=1` (git `ls-tree -r`, jj already recursive →
filter to files). FileTree search needs the full path list; per-dir lazy
loading would make search only cover visited dirs. Default behavior
unchanged; spec §11 table row updated. Not a contract change, but I'll flag
it at handover per process.md.

## Tests

- `tests/adapter.test.ts` — fixtures: `patchText` output for
  add/del/ctx/binary/added/deleted files; `fileDiffMetadata` shape
  assertions (name, type, hunk bookkeeping) transcribed from
  `diffs/src/types.ts`. Doubles as the version-bump smoke test.
- Adapter imports `@pierre/diffs` under node — SSR-guarded imports verified
  safe (web-components.ts guards on `typeof HTMLElement`).

## Risk / could break

- `@pierre/trees` is beta — fallback per pierre-packages.md: restore
  hand-rolled explorer with `jj restore` (file stays in history).
- Bundle ~1MB+ accepted (local-only tool, spec §2 note).
- Explorer UX changes shape slightly (tree panel instead of dir-per-page) —
  acceptable, spec §18.3 describes exactly this.
