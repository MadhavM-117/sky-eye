# Plan — 012 Parser guard against `diff.mnemonicPrefix`

## Problem
A user's global `git config diff.mnemonicPrefix true` makes `git diff` emit
mnemonic prefixes (`c/`/`w/` for commit-vs-worktree, `i/`/`w/` for
index-vs-worktree) instead of `a/`/`b/`. `parseUnifiedDiff` matches
`/^diff --git a\/(.*) b\/(.*)$/` → no match → 0 files → broken session view,
silently. Verified live in /tmp/mnem.

## Changes

1. `src/diff.ts` `buildDiff` — add `--no-mnemonic-prefix` to the git arg
   list (before `--end-of-options`; it's an option, must not land after the
   end-of-options marker). jj path untouched (jj doesn't have this config).
2. `src/diff.ts` `stripPathPrefix` — cheap belt-and-braces: after the
   `a/`/`b/` strip, also strip a mnemonic prefix (`c/ i/ n/ o/ w/`) so
   externally generated diffs still parse. Our own diffs always carry
   `a/`/`b/` (flag guarantees it), so this only fires for foreign input.
3. `src/diff.ts` `DIFF_GIT` header regex — widen to accept mnemonic
   variants (`c/ i/ o/` old side, `w/ n/` new side); without this the
   `diff --git` line still fails to match and `stripPathPrefix` alone
   wouldn't fix the 0-files bug for foreign diffs.

## Tests
- `tests/diffparse.test.ts`: fixture with mnemonic prefixes
  (`diff --git c/x w/x`, `--- c/x` / `+++ w/x`) → paths stripped, status
  correct.
- `tests/integration.test.ts`: repo with `diff.mnemonicPrefix true`
  configured → `buildDiff` output parses to ≥1 file (proves the flag).

## Docs
- `docs/spec.md` §7.1: add `--no-mnemonic-prefix` to the recorded git
  invocation.
- `.implementation/learnings/diff-parsing.md`: mark resolved, note the
  `--end-of-options` ordering gotcha.

## Could break
- Nothing else calls `buildDiff`/`parseUnifiedDiff` with assumptions about
  prefix chars (grep: store.ts, remap.ts — both go through the same parse).
- Over-stripping in `stripPathPrefix` only affects foreign no-prefix diffs;
  ours always have `a/`/`b/`.
