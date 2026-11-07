# 005 — M4 Chunker tuning — **done**

**Goal:** chapters split at function boundaries, keep-together rules,
`review` size config knob.

**Deliverable/acceptance** (spec §21 M4): fixture suite green; manual review
of a real 500-line diff reads sensibly. Decide large-diff virtualization
here (spec §22.5).

Spec: §8.

**Result:** `shouldSplit` implements §8.2/§8.4 — funcname from `Hunk.header`
(git + jj both emit it, §22.1) changes → split; same funcname keeps together
past `targetLines` up to `maxLines` (keep-together needs a context; without
one, `targetLines` + >30-line distance fallback still split). `review`
config knob was already live since M1. §22.5 resolved: chaptering is the
virtualization, no `VirtualizedFileDiff` swap in v1. Chapter boundaries are
separate sections in the frontend, so pierre hunk separators are untouched.
