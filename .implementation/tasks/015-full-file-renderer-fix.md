# 015 — Full-file renderer fix

**Goal:** the explorer's full-file view renders nothing — `File.render()`
returns, a `diffs-container` appears, but its shadow root stays empty (only
the SVG sprite). Reproduced headlessly against `tmp/demo`.

**Status:** **done** — root cause found and fixed (see plan
`.implementation/plans/015-full-file-renderer.md`); the file's syntax
language must be preloaded into the shared highlighter before
`File.render`, because pierre's deferred async-highlight re-render is
swallowed by its "nothing changed" render short-circuit (`@pierre/diffs`
1.6.4). Verified headlessly: file rows paint on the first render.
