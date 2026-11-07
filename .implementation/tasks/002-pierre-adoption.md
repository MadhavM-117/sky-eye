# 002 — Pierre adoption (frontend deps unlocked)

**Goal:** replace the hand-rolled diff renderer, highlighter, and explorer
tree with the `@pierre/*` packages, per the revised dependency policy
(spec §2, design §2). Working guidance lives in
`.implementation/docs/pierre-packages.md` — read it first; extend it with
everything this task learns (it ends with a known-unknowns list to resolve).

Prereq: M1 spine (001) exists with hand-rolled `diffview.js`,
`highlight.js`, `explorer.js`; parent commit already hand-ported pierre
styling. This task deletes those files in favor of the real packages.

Slices:

1. Add deps (`@pierre/diffs`, `@pierre/trees`, exact-pinned) + esbuild
   devDependency + `esbuild.config.mjs`; serve `public/dist/` statically.
2. `pierre-adapter.js` — the only module importing `@pierre/*`: map server
   `Session`/`Hunk`/`DiffLine` JSON → `FileDiff` render input; wire
   selection events back to app actions.
3. Session view: per-chapter `FileDiff` (split); delete `diffview.js` +
   `highlight.js`. Verify attention-mark styling hooks exist for 007 and
   annotation hooks for 003.
4. Explorer: `@pierre/trees` `FileTree` (search + `setGitStatus` for changed
   files) inside the existing breadcrumb/side-toggle chrome; delete the
   hand-rolled tree rendering.

**Accept:** same M1 acceptance criteria as 001, driven by pierre rendering;
no hand-rolled highlight/diff code remains; bundle builds in one command.
