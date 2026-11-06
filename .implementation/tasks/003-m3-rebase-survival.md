# 003 — M3 Rebase survival

**Goal:** comments survive rebases via the remap pass; both refresh flows
(jj: in place via diff digest, git: supersede via `headRef` resolution) work;
matched lines outside rebuilt diff hunks orphan into the triage banner.

**Deliverable/acceptance** (spec §21 M3): jj rebase → stale banner → refresh
→ comments re-pinned; git amend → stale banner → refresh → new session, old
marked superseded, comments carried and editable; no-match or out-of-hunk
comments orphan into triage.

Spec: §13. Verify the jj change-id session-key behavior and jj hunk-header
funcname question (spec §22.1) here if not resolved earlier.
