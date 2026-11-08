# sky-eye — UX specification

Companion to `design.md`. This document specifies what the user does and
sees; `design.md` specifies how it works. Anything decided here is binding
on the design.

## 1. Entry flow ("I want to see my diff")

### 1.1 Startup

User runs `sky-eye` inside a repository. The tool:

1. Detects the repo root and kind (see 1.2). Not in a repo → clear terminal
   error, no browser opens.
2. Ensures its state folder `.sky-watch/` inside the repo is ignored:
   appended to `.gitignore` (created if missing; jj honors gitignore too) and,
   if `.dockerignore` exists, to `.dockerignore`.
3. Starts the local server bound to `127.0.0.1` on its preferred port; if that
   port is taken (`EADDRINUSE`), it scans upward through user-space ports
   (>1024) until one binds.
4. Prints one line to the terminal:
   `sky-eye serving /path/to/repo (jj repo) → http://localhost:4800`
5. Opens the browser at that URL automatically (`xdg-open` / `open`).

All state lives in `.sky-watch/` and all stored paths are repo-relative, so
moving or renaming the repo directory does not break existing sessions.

The terminal line and the app header (see 3.1) together make it unambiguous
which directory and repo is being reviewed.

### 1.2 Repo detection

- `.jj` directory present → **jj mode**. (Colocated repos still have
  `.git`; jj wins.)
- Otherwise → **git mode**.
- Repo kind is shown as a badge in the UI header.

### 1.3 Ref discovery

The tool discovers what is available to compare and offers it in the
browser — the user does not pass refs on the command line for the normal
case. `GET /api/refs` returns:

- repo root + kind
- the current head (see 1.4)
- a default base suggestion
- bookmarks/branches (names + head commit ids)
- ~20 recent commits (id + subject)

**Empty data, not errors:** for any discovery gap (detached head, no
bookmarks, fresh repo, no commits yet) the endpoint succeeds with an empty
list for that category. A comparison that is impossible for structural
reasons (e.g. no base candidate exists at all) shows a message on the first
screen; the API itself still returns 200.

### 1.4 Ref semantics per repo kind

| | git mode | jj mode (v1) |
|---|---|---|
| Head side of the comparison | current branch (HEAD) | working copy `@` only |
| Default base | merge-base with default branch (main/master) | trunk bookmark, falling back to `@-` |
| Base candidates | local + remote branches, recent commits | bookmarks, recent commits |

- jj v1 offers **only the working copy** as the head side. Comparing two
  arbitrary heads/changes is a later addition.
- Base side is fully selectable: a dropdown listing the default base,
  bookmarks/branches, and recent commits.

### 1.5 First screen

Rendered top to bottom:

1. **Header** — repo root path + repo-kind badge.
2. **Compare picker** — "Review **[head]** against **[base dropdown]**" with
   the default base preselected, plus a "Create review" button. The
   dropdown groups: default base / bookmarks / branches / recent commits.
   Creating a review runs the full analysis server-side — the diff is
   chunked into chapters and every chapter gets its narrative and marks
   before the session opens (spec §16.2) — so the button is disabled and a
   banner shows "analyzing…" with an indeterminate spinner (per-chapter
   live progress is deferred — creation latency hasn't earned the
   streaming machinery yet). Without an LLM configured this is
   near-instant.
3. **Existing sessions** — human label (if set, else the id), branch
   aliases, `updatedAt`, open-comment count, and a reviewed chip; click to
   open.
4. **Archived reviews** — a muted line below the list, "n archived", that
   expands the archived reviews (label, `updatedAt`); each offers restore
   (back into the active list) and delete (with confirm). Archived reviews
   are not openable until restored.

There is no separate landing page: if no sessions exist the list section is
simply empty. Creating a review for a range that already has a session
opens that session instead of creating a duplicate (sessions are keyed by
`base..head`).

## 2. File explorer

A repo tree browser, like GitHub/GitLab's file view, reachable from the
header at any time:

- Directory listing navigable by clicking; breadcrumb at the top.
- Files open **read-only**, rendered with the same syntax highlighting as
  the diff view (unknown file types show as plain text).
- The tree can be shown at the head or base side of a session, so the user
  can compare "how this file looked before" against the diff.
- Changed files inside a diff chapter stay reachable via the chapter rail
  (§3.3); a file's diff block can also render the whole file in place
  (full-file mode, §3.2).

Read-only in v1: no editing, no blame, no history view.

## 3. Session view

### 3.1 Header

The header is laid out on three lines so each kind of information gets its
own row and nothing competes for attention:

1. **Title row** — session label (click to edit; falls back to the raw id
   when unset), repo-kind badge, branch alias(es), open-comment count.
2. **Context row** — the full path to the repository being reviewed
   (`meta.repo`, display only), the current (head) branch, and the base
   branch the review compares against — so it is always unambiguous what is
   under review and against what.
3. **Actions row** — grouped, primary first, so the row reads at a glance:

   - **Primary buttons** (always visible): **mark reviewed** (a button, not
     a checkbox — toggles the session's reviewed state; when reviewed it
     shows the marked state and clicking unmarks), **files** (explorer),
     **export**.
   - **Overflow menu** ("more ▾", collapsible): regenerate all (one click
     re-runs marks + narratives for every chapter; asks once before
     overwriting any edited narrative; while it runs the button is
     disabled, a banner reports progress and each chapter shows the same
     "analyzing…" indicator as a per-chapter re-run), re-group (re-runs the
     chapter grouping on the stored diff — semantic titles return via the
     chunk task, spec §8a; asks once before overwriting edited narratives
     since chapter ids may move), archive (review leaves the list, findable
     on the first screen), delete (confirm — permanent).

Every action shows **help text on hover** explaining what it does,
including its side effects (delete says "permanent", archive says it
leaves the list). Refresh stays in the stale banner (below): it only
exists when there is something to refresh.

**Stale session:** if the diff behind the session has changed (head moved,
or a jj rebase rewrote the commits under it), a "review is stale — refresh?"
banner appears. Refreshing re-anchors comments via the remap pass. In git
mode a rebase also breaks the session key, so refreshing lands on a new
session (the old one kept as history, marked superseded); in jj mode the
key survives a rebase and the session updates in place.

### 3.2 Body

The session body renders **one chapter at a time**; the chapter rail (§3.3)
on the left navigates between chapters and lists the active chapter's
files.

- Chapter header: title — the semantic chapter title when the chunk task
  produced one (spec §8a), else the chapter's file list — plus one-line
  narrative placeholder ("unanalyzed" only when the chapter could not be
  analysed: no LLM configured or the call failed; a served session is
  analysed up front, spec §16.2). Chapters are ordered for reading — the
  analysis arranges them so the review builds understanding (spec §16.7),
  path order only as fallback. The header also carries a **viewed toggle**:
  marking the chapter viewed marks every file in it viewed (spec §9.3).
- Narrative paragraph above the diff as rendered
  markdown (a muted "not analyzed yet" placeholder until then). While a
  re-run regenerates the draft, a spinner + "analyzing…"
  replaces the view and the edit button is hidden. An ✎ edit button swaps
  the view for a textarea (save/cancel) prefilled with the current markdown
  text — minor edits are the common case, so editing starts from what's
  there, not a blank field; markdown is stored verbatim. A re-run that
  would overwrite a human-edited narrative asks first.
- Below it: per-file diff blocks in path order — a chapter may span several
  files, each block with its own file path heading; GitHub-style two-column
  diff (old left, new right), hunks with context lines. Code is syntax-highlighted by the pierre
  highlighter (152 languages, plain-text fallback) — file views and diff
  lines use the same highlighter and theme.
  Each per-file block is an **accordion**: clicking **anywhere on the file
  bar** (the whole heading row) collapses/expands its diff — the viewed
  checkbox and the full-file button are the only click targets on the bar
  that do not toggle. The bar shows the file path as **plain text** (no
  implicit link), a status glyph, the **viewed checkbox**, and an explicit
  **full file** button that swaps the block's diff view for the whole file
  rendered in the same diff viewer — and back.
- **Full-file mode**: the full-file button renders the entire file in the
  diff viewer — every line visible, the changed lines still marked — by
  expanding the hunks to whole-file context (no new data: the adapter pads
  the hunk list with context lines from the file content, spec §18). In
  this mode **any line is commentable**, not only changed ones: a gutter
  click on an unchanged line opens the same composer and stores the same
  content anchor (spec §12). Such comments re-anchor on refresh and stay
  pinned as long as their line still matches the file content, even when
  it lies outside every diff hunk (spec §13.3); they are visible only in
  full-file mode, and the open-comment count includes them.
- The viewed checkbox: marking a file viewed persists (spec §9.3) and
  collapses the block immediately; a viewed file renders collapsed by
  default. Collapsing alone is ephemeral (not persisted) — unmarking
  viewed does not auto-expand a block; expanding it again is one click.
- **Attention marks** render in a dedicated gutter column beside the line
  numbers, one glyph per marked line: ◆ focus / ▲ glance / ● safe (custom
  classifier names → the name's initial in the muted color, e.g. `S` for
  `skim`), colored by mark, with the mark name and source on hover. Marks
  never take space below the line — that's for comments — so mark-dense
  diffs stay readable.
- **Deep links**: hovering a diff line or comment exposes a copy-link
  (local URL fragment). Opening one opens the owning chapter, scrolls to
  and highlights the target; links survive export/import and break on
  rebase like everything else session-keyed.

Empty diff (no chapters) → a "nothing to review for this comparison"
message.

### 3.3 Chapter rail

Navigation for the one-chapter-at-a-time body (§3.2): a collapsible rail on
the left, computed client-side from the session JSON the view already has
(change counts come from the slices' hunk lines) — no new endpoints, no
schema change.

One row per chapter, in review order:

- **Title** — the semantic chapter title when the chunk task produced one
  (spec §8a), else the file list (first file, "+ n more" when long).
- **One-line description** — the narrative's first line, or "unanalyzed".
- **Change summary** — `N files · +x −y`: file count plus added/deleted
  changed lines across the chapter's hunks.

Clicking a row switches to that chapter; the active row is highlighted and
nests the chapter's **file list** (in path order): file path, status glyph
(A added / D deleted / M modified), and the per-file change summary `+x −y`
from that slice's hunks. Clicking a file scrolls to that file's diff block
(scroll-and-flash, as with deep links). Prev/next chapter controls move
between chapters.

Chapter rows and nested file rows show a viewed glyph (✓) — the file's own
viewed state, and the chapter's derived one (all files viewed → chapter
viewed, spec §9.3). The rail's glyphs are read-only display; toggling lives
in the body's headers (§3.2).

Opening a session starts at the first chapter. A deep link targeting a
chapter, a file/line, or a comment opens the owning chapter, then scrolls
and flashes the target.

## 4. Deferred UX (not designed yet)

Comment composer, resolve interactions, comment priority (nit / must-fix —
one selector in the composer), orphan triage banner, export/import UI, LLM
narrative display details — designed when their milestones start (T3+).
They are noted here so the session view layout leaves room for them
(gutter click targets on diff lines, header counters).
