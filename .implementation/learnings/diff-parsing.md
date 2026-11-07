# Diff parsing

- `stripPathPrefix` assumes `a/`/`b/` prefixes; a user's `diff.mnemonicPrefix`
  config makes `git diff` emit `i/`/`w/` and `parseUnifiedDiff` returns 0
  files (found while manually verifying task 005). **Resolved (task 012)**:
  `buildDiff` passes `-c diff.mnemonicPrefix=false`; parse also tolerates
  mnemonic headers (`c/i/o` ↔ `w/n`) for foreign diffs. There is **no**
  `--no-mnemonic-prefix` git option — only the `-c` config override works
  (git exits 129 on the negated option).
