# 010 — Multi-file chapters

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

**Ripple into later tasks:** `LineMark` now carries `file` — task 010 (M5
attention marks) must set it when marking lines. 011/012 (export/import,
narratives) inherit the model; 012's prompt will receive multi-file diffs.

Spec: §8, §9.3, §12, §13.3; design.md D§3 row 2, D§4; ux.md U§3.2.
