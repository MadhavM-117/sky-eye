# Diff parsing

- `stripPathPrefix` assumes `a/`/`b/` prefixes; a user's `diff.mnemonicPrefix`
  config makes `git diff` emit `i/`/`w/` and `parseUnifiedDiff` returns 0
  files (found while manually verifying task 004). Fix candidate: pass
  `--no-mnemonic-prefix` (or `-c diff.mnemonicPrefix=false`) in `buildDiff`.
  Tracked as task 009.
