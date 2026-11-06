# Build process

How we build sky-eye. `docs/spec.md` is the binding implementation spec
(deciding what `docs/design.md` and `docs/ux.md` left open); those docs are
the source of truth — when reality diverges from them, update the docs, don't
fork knowledge into conversations. This file only governs *how* we work.

## Task lifecycle

1. **Pick a task** from `.implementation/tasks/` (one numbered file per
   task; new todos become the next free number, never renumber). Work in
   number order unless agreed otherwise.
2. **Plan first** — write `.implementation/plans/<task#>-<slug>.md` before
   implementing anything, even if its only purpose is organizing thoughts:
   what changes, which files, what could break, how it's tested. If the plan
   surfaces real unknowns, pause and check in before coding.
3. **Implement** — the smallest change that fully solves the task, following
   the foundations below.
4. **Test** — per `docs/spec.md` §20: pure logic as fixtures; CLIs spawned
   only at integration boundaries.
5. **Check in** — jj commit with a conventional message.
6. **Hand over for feedback** — the task ends with something the user can
   interact with. Where a task has no user-visible surface, its test suite
   plus a short manual verification recipe counts.
7. **Fold back feedback** — user feedback becomes doc updates and/or new
   task files before the next task starts. Never build on unstated
   decisions.

## Pause and ask when

- deviating from the spec/design, or a spec §22 open question reaches its
  task — decide together, then write the decision back into the docs
- a new dependency, a schema change, or an API contract change is needed
- anything is ambiguous or uncertain — check in, never guess silently

## Foundations (apply to every task)

- Strict TypeScript types are the single schema source (`Session`,
  `Comment`, … defined once, imported everywhere).
- Server logic lives in pure functions; CLIs are spawned only at
  integration boundaries.
- Customization stays cheap: all theme values are CSS custom properties,
  user-adjustable behavior goes through `.sky-watch/config.json` (spec
  §16.1 scheme). Nothing user-facing is hard-coded. v1 ships no dark mode
  or theme UI — the architecture just must not block adding them.
- Written for human understanding first: clear names, small files, comments
  explain *why*.

## Repo map

- `docs/` — design.md, ux.md, spec.md (binding specs)
- `process.md` — this file
- `.implementation/tasks/` — numbered task files (3-digit prefix)
- `.implementation/plans/` — per-task plans, named `<task#>-<slug>.md`
