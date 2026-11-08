# Plan: Chapter navigation & eager analysis (task 020)

Feature dir: `./tmp/plans/chapter-nav/` — this file is the working plan.
Mirrored to `.implementation/plans/020-chapter-nav.md`; the task entry goes
to `.implementation/tasks/020-chapter-nav.md` (+ index line) as step 0.

## Goal

Three linked changes, all specced (spec §16.2/§16.7, ux §3.2–3.3):

1. **One chapter at a time** — the session body renders a single chapter;
   a collapsible chapter rail on the left navigates (title, one-line
   narrative description, `N files · +x −y`) and nests the active chapter's
   file list (path, A/D/M glyph, per-slice `+x −y`, click scrolls to the
   file block). Prev/next controls. The all-chapters accordion goes away.
2. **Eager analysis** — every chapter-building pipeline (create, refresh,
   supersede, rechunk) ends with a narrate pass over chapters that have no
   narrative yet, so a served session is fully analysed. Degrade rule
   unchanged: no config / failed call → "unanalyzed", never blocks.
3. **Chapter ordering** — chapters are physically ordered for reading:
   semantic chunker order when the chunk task produced the grouping;
   otherwise one cheap ordering LLM call (when narrate/classify configured);
   else path order.

Non-goals: streaming/SSE progress, keyboard navigation, persisting the
active chapter across reloads (deep links cover it), reordering on
rerun-all.

## Current behavior (verified in code)

- `renderSession` (`src/public/app.js:226`) renders **all** chapters as
  `<section class="chapter">`; `chapterHtml` (app.js:303) already computes
  per-chapter add/del counts and renders a collapse button
  (`.collapse` toggles `.collapsed`, app.js:739). Deep-link scroll+flash
  via `tryScroll` (app.js:651) with targets `line` / comment id / chapter id;
  diff instances keyed `` `${chapter.id}\u0000${file}` `` in a `diffs` map
  (app.js:511).
- Rebuild pipeline `chaptersFromDiff` (`src/store.ts:165`): semantic chunk
  (when `tasks.chunk` resolves, `src/semantic-chunk.ts`) → pure chunker
  fallback → `withAttention` rules marks → `applyClassifier`. **No narrate.**
- Narration `src/narrate.ts`: `rerunChapter` / `rerunAll`; the per-chapter
  core `narrateOne` (shared call when narrate+classify share an adapter,
  else two calls; each degrades independently). `rerunAll` = rules marks →
  `applyClassifier` → sequential `narrateOne` loop → `persistSession`.
  `persistSession` comes from `store.ts` → **store→narrate would be a
  circular import**.
- `carryNarratives` (`src/remap.ts:160`) rides chapter ids in refresh (jj),
  supersede (git) and `rechunkSession`; none of them narrate new chapters —
  with lazy firing gone, those chapters would stay "unanalyzed" forever.
- Creation loader already exists: `analyzing diff into chapters…` spinner
  banner during the create POST (app.js:157). rerun-all shows a static
  count banner (app.js:605) — precedent: no live per-chapter progress.
- `resolveTask(root, "narrate" | "classify" | "chunk")` (`src/llm.ts:125`).
- Chapter ids: 12-hex sha256 of slices (§8.5) — reordering does not move
  ids, anchors, deep links or exports.

## Approach

### Why this shape (trade-offs)

- **New `src/analyze.ts` instead of extending `chaptersFromDiff`:**
  `narrate.ts` imports `persistSession` from `store.ts`, so having
  `store.ts` call the narrate loop is a circular import. `analyze.ts`
  imports from both (narrate → store is already the existing direction) and
  owns "finish the analysis" as one exported function the three route
  handlers call. Keeps `chaptersFromDiff` pure-ish (chunk + marks only).
- **Ordering skips when the chunk task resolves:** if semantic chunking is
  configured, its grouping order is the reading order (§8a) — and if that
  call degraded to the pure chunker, path order is an acceptable fallback.
  Checking "did the model actually group?" would mean threading a flag out
  of `chaptersFromDiff` for no real gain.
- **Physically reorder `session.chapters`:** everything (rail order, prompt
  context `otherTitles`, deep links, export) reads the array order; ids
  don't move, so nothing else changes.
- **Indeterminate creation spinner (shortcut):** spec §16.2 / ux §1.5
  mention per-chapter progress. Live progress needs SSE or a job-poll
  protocol — machinery out of proportion for a wait the user accepts.
  v1 keeps the existing indeterminate banner; add a
  `shortcut: live per-chapter progress, when creation latency annoys`
  comment at the banner. Update the two doc lines to match if the deviation
  bothers (one-line edit).
- **Sequential narrate loop** (same as `rerunAll`): N blocking calls at
  creation, accepted by spec. Parallelizing is a later optimization.

### 1. `src/analyze.ts` (new) — eager pass + ordering

```ts
// Eager analysis (spec §16.2/§16.7): the final step of every chapter-
// building pipeline. Fills narratives for chapters without one (never
// overwrites — fresh chapters have narrativeEdited unset by definition),
// then orders chapters for reading. Degrade rule (§16.1): no adapter or a
// failed call leaves the chapter "unanalyzed" / path-ordered; the session
// never blocks on the LLM layer.
import { resolveTask } from "./llm.ts";
import { narrateChapter, orderChapters } from "./narrate.ts";
import { persistSession, type } from "./store.ts"; // types only where possible

export async function ensureAnalyzed(
  root: string,
  kind: "git" | "jj",
  session: Session,
  adapters?: Adapters, // injectable for tests, resolved from config when absent
): Promise<Session> {
  const a = adapters ?? { narrate: resolveTask(root, "narrate"), classify: resolveTask(root, "classify") };
  if (a.narrate || a.classify) {
    for (const chapter of session.chapters) {
      if (!chapter.narrative || chapter.narrative === "unanalyzed")
        await narrateChapter(a, root, kind, session, chapter);
    }
    // ordering (§16.7): skip when semantic chunking is configured — its
    // grouping order already is the reading order
    if (!resolveTask(root, "chunk")) await orderChapters(root, session, a);
  }
  return persistSession(root, session);
}
```

Refactor in `narrate.ts`: extract the body of `rerunAll`'s narrate loop into
an exported `narrateChapter(a, root, kind, session, chapter)` (thin wrapper
around the existing private `narrateOne`) so `rerunAll`, `rerunChapter` and
`ensureAnalyzed` share one core. `rerunAll` keeps its persist + 409 gate.

### 2. Ordering pass (in `narrate.ts`)

```ts
// §16.7: one cheap call over the chapter list; reply is ONLY
// {"order": ["<chapterId>", ...]}. Pure validation: unknown/duplicate ids
// dropped (first wins), missed chapters keep path order appended at the
// end; malformed → path order (degrade, don't fail).
export function parseOrderResponse(raw: string, chapters: Chapter[]): string[] // pure, fixture-tested
export async function orderChapters(root: string, session: Session, a: Adapters): Promise<void>
```

- `orderChapters` uses `a.narrate ?? a.classify` (any configured LLM).
  Skip when `session.chapters.length < 2` (nothing to order).
- Prompt input per chapter: id, title-or-file-list (`chapterTitle`),
  `+x −y` changed-line counts, per-slice statuses — a compact list, no diff
  text (cheap on purpose; the narratives carry the semantics).
- System prompt, house style of `narrateSystemPrompt()`: "You order the
  chapters of a code review so a reviewer builds understanding: foundations
  and data-model changes before their consumers, related chapters adjacent…
  Reply with ONLY JSON: `{"order": ["<id>", …]}` — every id exactly once."
- On success: `session.chapters.sort` to the validated permutation.

### 3. Route handlers (`src/routes.ts`) — call `ensureAnalyzed`

```ts
// POST /api/sessions
const { session, created } = await createSession(...);
return created ? await ensureAnalyzed(root, kind, session) : session;

// POST /api/sessions/:id/refresh — covers both jj in-place and the git
// successor (createSuccessor leaves successor.chapters to be narrated)
const r = await refreshSession(...);
return { ...r, session: await ensureAnalyzed(root, kind, r.session) };

// POST /api/sessions/:id/rechunk
return ensureAnalyzed(root, kind, await rechunkSession(...));
```

Supersede note: `refreshSession` sets `supersededBy` and persists the old
session, returning the successor — analyzing the returned session is
exactly the successor. No change inside `remap.ts`.

### 4. Frontend: one-chapter-at-a-time + rail (`src/public/app.js`, `style.css`)

- **State:** module-level `let activeChapterId = null` (reset on session
  switch in `render()`; default = first chapter). `renderSession` renders
  the rail + only the active chapter's `<section>`.
- **Rail** (`.session-layout` grid `280px 1fr`, rail left, collapsible via
  a header button toggling a class):
  - row per chapter, in `session.chapters` order: `chapter N` + title
    (existing `chapterTitle` logic client-side: `c.title` else file list),
    first narrative line or "unanalyzed" (plain text, `esc()`), and
    `N files · +x −y` — extract `chapterStats(c)` (the reduce already in
    `chapterHtml`) and a per-slice variant, reuse in both places.
  - active row highlighted; nested file list under it: path, status glyph
    (`<span class="status …">` reuse), per-slice `+x −y`; click scrolls to
    the file block (already in the DOM) via the `tryScroll` pattern;
    the existing explorer `<a class="file-link">` stays.
  - row click (not on a file row): set `activeChapterId`, re-render the
    body (full `renderSession(current)` — same re-mount cost as today's
    refetch path; acceptable).
- **Chapter head:** add ◀ prev / ▶ next buttons (wrap at the ends? no —
  disabled at the edges); **remove** the `.collapse` button + its handler
  (app.js:739) — obsolete in the one-chapter view.
- **Deep links (§17):** in `renderSession`, before building HTML: if
  `route.target === "line"` → owning chapter is `route.chapterId`; if
  target is a comment id → `comments.find(...).chapterId`; if target is a
  chapter id → itself. Set `activeChapterId` accordingly; the existing
  `tryScroll` block then works unchanged (the target diff/chapter is
  mounted).
- `narrativeViewHtml` placeholder text stays ("not analyzed yet") — it is
  now the failure/no-config case only; no lazy auto-rerun exists in the
  code today (rerun is manual), so nothing to remove there.
- CSS (`style.css`): grid layout, rail row styles, active highlight,
  nested file list, prev/next buttons; make sure the pierre diff container
  gets the remaining width (existing `containerWrapper` rule).

### 5. Tests (`tests/`)

- **`ordering.test.ts`** (new, pure): `parseOrderResponse` — valid
  permutation reorders; unknown ids dropped; duplicate id first-wins;
  missing chapters appended in path order; malformed JSON → path order;
  single-chapter / empty input no-ops.
- **`narrate.test.ts`**: `ensureAnalyzed` with fake adapters — chapters
  with a narrative (incl. `narrativeEdited`) untouched; empty narratives
  filled; no adapters → session unchanged; ordering reorders `chapters`
  in place; chunk-adapter-configured → ordering skipped (inject a stub
  `resolveTask` seam or pass a flag — prefer an `adapters.chunk`
  field on the injectable to keep `resolveTask` unmocked).
- Integration (`integration.test.ts`): create → all chapters have
  narrative !== "" when fake adapters resolve; without config →
  "unanalyzed" and 201 still fast. (Follow the existing fake-adapter
  pattern in narrate tests.)

### 6. `.implementation/` bookkeeping (step 0 of execution)

- Create `.implementation/tasks/020-chapter-nav.md` (goal + acceptance
  criteria, house format) and add the index line to
  `.implementation/tasks/000-index.md`.
- Copy this plan to `.implementation/plans/020-chapter-nav.md`.
- Learnings: add anything learnt to `.implementation/learnings/`
  (likely topics: `frontend-routing.md` for the rail/deep-link interplay,
  `server-protocol.md` if the analyze flow surprises).

## Files touched

| File | Change |
|---|---|
| `src/analyze.ts` | **new** — `ensureAnalyzed` |
| `src/narrate.ts` | export `narrateChapter` wrapper, add `orderChapters` + `parseOrderResponse` |
| `src/routes.ts` | 3 handlers call `ensureAnalyzed` |
| `src/public/app.js` | rail + one-chapter body, `chapterStats`, deep-link chapter resolution, remove collapse |
| `src/public/style.css` | rail layout, active/file rows, prev/next |
| `tests/ordering.test.ts` | **new** — pure fixtures |
| `tests/narrate.test.ts`, `tests/integration.test.ts` | eager-pass fixtures |
| `.implementation/tasks/…`, `.implementation/plans/…` | step 0 |

No dependency changes; no schema change (`chapters` array order is the only
new state, already serialized).

## Risks

- **Creation latency** = chunk call + N sequential narrate calls; spec'd as
  accepted with the indeterminate spinner. If it bites: parallelize the
  loop (promises, order-independent since each chapter mutates itself) —
  one-line-ish follow-up.
- **Ordering call misfires** (model reorders nonsensically): same exposure
  as semantic grouping; degrade path returns path order. No user override
  in v1 (drag-to-reorder is a later feature if wanted).
- **Rail re-render** remounts the pierre diff on every chapter switch —
  same cost class as today's refetch re-render; if switching feels slow,
  render both chapters' diffs once and toggle visibility (optimization,
  not needed for ≤200-line chapters).
