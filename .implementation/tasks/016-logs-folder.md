# 016 — Logs under `.sky-watch/logs/`, only the latest kept

**Goal:** all generated logs live in a `logs/` folder under `.sky-watch`;
only the most recent log is preserved — older ones are deleted/overridden.

**Status:** **done** — the classifier log moved from
`.sky-watch/classifier.log` (with `.1` one-run rotation) to
`.sky-watch/logs/classifier.log`, overwritten per run (only the most recent
run kept, user decision). Spec §16.5 + §9.2 updated.
