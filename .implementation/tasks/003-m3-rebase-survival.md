# 003 — M3 Rebase survival

**Goal:** comments survive rebases via the remap pass; both refresh flows
(jj: in place, git: supersede) work; orphan triage banner.

**Deliverable/acceptance** (spec §21 M3): jj rebase → stale banner → refresh
→ comments re-pinned; git amend → new session, old marked superseded,
comments carried; no-match comments orphan into triage.

Spec: §13. Verify the jj change-id session-key behavior and jj hunk-header
funcname question (spec §22.1) here if not resolved earlier.
