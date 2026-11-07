# 004 — M3 Rebase survival

**Goal:** comments survive rebases via the remap pass; both refresh flows
(jj: in place via diff digest, git: supersede via `headRef` resolution) work;
matched lines outside rebuilt diff hunks orphan into the triage banner.

**Deliverable/acceptance** (spec §21 M3): jj rebase → stale banner → refresh
→ comments re-pinned; git amend → stale banner → refresh → new session, old
marked superseded, comments carried and editable; no-match or out-of-hunk
comments orphan into triage.

Spec: §13. Verify the jj change-id session-key behavior and jj hunk-header
funcname question (spec §22.1) here if not resolved earlier.

Pierre notes (after 002): this task is server-side (remap, refresh, supersede)
— no new pierre API surface. Frontend impact only: rebuilt chapters re-render
through the same adapter (annotation set is replaced wholesale after a
refresh), and the orphan-triage re-pin click reuses the selection API path
built in 003. Keep the adapter's annotation projection idempotent — refresh
re-projects from server state, never mutates pierre model state incrementally.
