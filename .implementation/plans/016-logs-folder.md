# Plan 016 — Logs folder

## Change

`src/custom-classifier.ts` `writeLog`:

- Log file becomes `.sky-eye/logs/classifier.log` (`mkdirSync` the `logs/`
  folder).
- Drop the one-run rotation (`renameSync` to `.1`): the file is overwritten
  per run — only the most recent run is kept (user decision). Update the
  comment that described the rotation decision (plan 008 is superseded).
- Leave pre-existing `.sky-eye/classifier.log(.1)` files in user repos
  alone (they're just stale cache in `.sky-eye/`); no migration.

## Touch points

- spec §16.5 (log path + rotation semantics) — done before implementation.
- `tests/custom-classifier.test.ts` — no test asserts the log path (grep
  confirmed); add one assert-style check only if a log test already exists
  (it doesn't — keep it lean, the log write is already failure-isolated).

## Verification

- Manual/CDP: run a classifier config in tmp/demo (or unit-spawn
  `applyClassifier` against a temp root) → `.sky-eye/logs/classifier.log`
  exists, `.sky-eye/classifier.log.1` is no longer created.
