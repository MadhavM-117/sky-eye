# AGENTS.md

sky-eye — a local code review helper (a PR-style, chaptered diff review
running entirely on your machine). Before working in this repo:

1. Read `docs/spec.md` (binding) and, where it references them,
   `docs/design.md` and `docs/ux.md`. Specs are the source of truth: update
   them when reality diverges, don't leave decisions only in conversation.
2. Follow `process.md` — task lifecycle, pause triggers, foundations.
3. Tasks live in `.implementation/tasks/` (numbered, work top-down);
   per-task plans go to `.implementation/plans/<task#>-<slug>.md` and are
   written *before* implementation.
4. This is a jj repo: conventional commits, working copy described and a new
   change started at each task boundary.
