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
3. **Existing sessions** — human label (if set, else the id), branch
   aliases, `updatedAt`, open-comment count, and a reviewed chip; click to
   open.

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
- Changed files inside a diff chapter link to their explorer view.

Read-only in v1: no editing, no blame, no history view.

## 3. Session view

### 3.1 Header

Session label (click to edit; falls back to the raw id when unset), branch
alias(es), open-comment count, reviewed toggle. Actions: refresh (below),
re-run (chapter analysis), export. Repo path + kind badge persist here too.

**Stale session:** if the diff behind the session has changed (head moved,
or a jj rebase rewrote the commits under it), a "review is stale — refresh?"
banner appears. Refreshing re-anchors comments via the remap pass. In git
mode a rebase also breaks the session key, so refreshing lands on a new
session (the old one kept as history, marked superseded); in jj mode the
key survives a rebase and the session updates in place.

### 3.2 Body

Chapters as an accordion, rendered **expanded** by default (a review is
read top to bottom; collapsing is an optimization, not the default).

- Collapsed chapter: title, one-line narrative placeholder ("unanalyzed"
  until narratives exist).
- Expanded chapter: the narrative paragraph sits above the diff as a plain
  editable text field — the LLM generates a draft on first expansion, the
  user can rewrite or write it from scratch at any time. A re-run that would
  overwrite a human-edited narrative asks first.
- Below it: the file path heading, GitHub-style two-column diff (old left, new
  right), hunks with context lines. Code is syntax-highlighted (`public/highlight.js`,
  plain-text fallback) — file views and diff lines use the same highlighter.
- **Deep links**: hovering a diff line or comment exposes a copy-link
  (local URL fragment). Opening one scrolls to and highlights the target;
  links survive export/import and break on rebase like everything else
  session-keyed.

Empty diff (no chapters) → a "nothing to review for this comparison"
message.

## 4. Deferred UX (not designed yet)

Comment composer, resolve interactions, comment priority (nit / must-fix —
one selector in the composer), orphan triage banner, export/import UI, LLM
narrative display details — designed when their milestones start (T3+).
They are noted here so the session view layout leaves room for them
(gutter click targets on diff lines, header counters).
