# 023 — File-bar accordion behavior + full-file diff mode with unchanged-line comments

**Goal:** the per-file diff block behaves like a proper accordion with an
explicit full-file view (ux §3.2, spec §13.3/§17/§18, design §6b):

- Clicking **anywhere on the file bar** toggles collapse/expand — the
  viewed checkbox and the full-file button are the only exceptions. The
  file path becomes plain text (the implicit link to the explorer is
  removed; the rail and the header's files link remain the routes to the
  explorer).
- An explicit **full file** button on the bar swaps the block to
  **full-file mode**: the whole file renders in the same diff viewer with
  changed lines still marked. No new endpoint, no schema change — the
  adapter pads the stored hunks with context lines built from the head file
  content (fetched via the existing `/api/file`); swap back restores the
  diff view.
- In full-file mode **any line is commentable**: gutter click on an
  unchanged line opens the same composer and stores the same server-side
  anchor (spec §12).
- Remap (§13.3): a comment whose re-anchored line matches content but lies
  outside every rebuilt hunk stays **pinned** (unchanged-line comment,
  `orphaned: false`) — visible only in full-file mode; only a failed
  content match orphans. Deep links (§17) to such a line/comment force the
  block into full-file mode before scroll+flash.

**Acceptance criteria:**
- Bar click toggles; clicking the viewed checkbox and the full-file button
  does not toggle; the path is not a link.
- Full-file mode renders the whole file (highlighted, changed lines marked,
  marks + comments in place) and toggles back cleanly; large files are an
  accepted perf tradeoff (explicit user action; `VirtualizedFileDiff`
  remains the upgrade path, §22.5).
- Comments on unchanged lines: created in full-file mode, counted in the
  open-comment count, visible only in full-file mode; a jj refresh / rebase
  remap keeps them pinned when the line still matches, orphans them when it
  doesn't.
- Deep link / triage re-pin to an out-of-hunk target opens full-file mode
  first, then scroll+flash.
- Remap fixtures extended (unchanged-line pinned case); integration
  round-trip unchanged (`viewedFiles` untouched); existing suite green.

Plan: `.implementation/plans/023-file-bar-full-file-mode.md` (to write at
task start)
