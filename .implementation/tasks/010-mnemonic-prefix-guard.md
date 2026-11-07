# 010 — Parser guard against `diff.mnemonicPrefix`

**Goal:** `git diff` with a user's `diff.mnemonicPrefix=true` emits
`i/`/`w/` path prefixes and `parseUnifiedDiff` silently returns 0 files
(broken session views). Pass `--no-mnemonic-prefix` in `buildDiff`'s git
args (and guard `stripPathPrefix` if cheap) so parsing is config-proof.

Found while manually verifying task 005; see
`.implementation/learnings/diff-parsing.md`.

Spec: §7.1 (git invocation).
