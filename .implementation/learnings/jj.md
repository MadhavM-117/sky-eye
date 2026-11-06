# jj

- `jj diff --git` (jj 0.46) DOES emit funcname context in hunk headers
  (`@@ -1,9 +1,10 @@ fn a() {`) — same as git. Spec §22.1 resolved; chunker
  function-boundary rule works in jj mode without a heuristic fallback.
- `jj config set --repo user.name Test` works for test-repo identity setup.
- `jj describe`/`jj new` have no `-q` flag in 0.46 — redirect output instead.
- jj honors `.gitignore` in colocated repos, so test repos need the
  `.sky-watch/` line main.ts writes at startup, or session state leaks into
  rebuilt diffs (and flips staleness forever — the persisted digest can
  never match a diff that includes itself).
