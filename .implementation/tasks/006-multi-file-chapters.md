# 006 — Multi-file chapters — **done**

**Goal:** a chapter can encompass hunks from several files; the file-boundary
split rule is removed from the chunker. Comments, anchors, remap, deep links
and the UI work per file slice inside a chapter.

**Decided** (user, this session): proper multi-file chapters with the full
complexity — not a small-file-merging compromise. Chapters keep path order
and hold at most one contiguous slice per file.

**Deliverable/acceptance:** chunker merges small adjacent-file hunks into one
chapter; comments anchor/re-pin correctly inside multi-file chapters.
**No legacy migration** (decided): sessions persisted before this schema are
treated as absent — `.sky-watch/` is derived cache, losing old sessions is
accepted. Spec §8/§9.3/§13 updated (done with this task's doc edits);
design.md D§3 row 2 + D§4 updated.

**Ripple into later tasks:** `LineMark` now carries `file` — task 007 (M5
attention marks) must set it when marking lines. 008/009 (export/import,
narratives) inherit the model; 009's prompt will receive multi-file diffs.

Spec: §8, §9.3, §12, §13.3; design.md D§3 row 2, D§4; ux.md U§3.2.

**Result:** `Chapter.files[]` slices (one contiguous slice per file, path
order); chapter id hashes all slices; chunker splits only on funcname change
within a file, >30-line distance, or size — small files merge into one
chapter. Comments validate against slices; remap checks visibility per
`anchor.file` slice; legacy sessions count as absent on load **and** on the
createSession exists-branch (both paths needed — see
`.implementation/learnings/chapter-model.md`). Frontend: one pierre diff
block per slice under the chapter head; composer/deep-link/triage keyed
`chapterId\u0000file`. Verified live in `tmp/demo` (7 hunks → chapter 1
spans config.yaml + README.md + service.py, rest split at function
boundaries); comment on a non-first slice anchors correctly. 65/65 tests.
