// The ONLY module importing @pierre/* (spec §18, spec §2 isolation rule).
// Server JSON in → pierre render input out; pierre events back → app
// callbacks. Pure projection: no app state is stored in pierre model
// objects; callers re-render by re-projecting, never by mutating pierre
// model state.
import {
  File,
  FileDiff,
  DEFAULT_THEMES,
  getFiletypeFromFileName,
  getSharedHighlighter,
  parsePatchFiles,
  resolveTheme,
} from "@pierre/diffs";
import { FileTree, themeToTreeStyles } from "@pierre/trees";

// FileDiff/File render nothing until the shared highlighter is loaded
// (renderDiff returns undefined on the first sync pass otherwise). Call once
// at startup; every later render is synchronous. Language grammars lazy-load
// per diff and re-render when ready — no need to preload them.
let highlighterReady = null;
export function initPierre() {
  highlighterReady ??= getSharedHighlighter({
    themes: [DEFAULT_THEMES.light, DEFAULT_THEMES.dark], langs: [],
    preferredHighlighter: "shiki-js",
  }).catch((e) => {
    highlighterReady = null; // retry next render; diffs falls back to plain text
    throw e;
  });
  return highlighterReady;
}

// Re-serialize sky-eye hunks into unified-diff text. Pierre's own parser
// (parsePatchFiles) then computes the render metadata with all its hunk
// bookkeeping — hand-building FileDiffMetadata would duplicate that logic.
// Hunk headers are stored verbatim server-side, so counts round-trip.
// No renames exist in sky-eye diffs (server runs --no-renames, spec §7.1),
// so the a/ side always equals the path.
// shortcut: "\ No newline at end of file" markers were never parsed
// (src/diff.ts drops them); upgrade if EOF-marker rendering ever matters.
// `file` is {path, status}; app.js passes {path: chapter.file, status: chapter.status}.
export function patchText(file, hunks) {
  if (hunks.length === 0) return "";
  const lines = [`diff --git a/${file.path} b/${file.path}`];
  // mode lines are how pierre's parser tags files as new/deleted; git modes
  // aren't stored server-side, so the value is fixed 100644 (rendering only
  // uses the type, and the file header is disabled anyway)
  if (file.status === "added") lines.push("new file mode 100644");
  else if (file.status === "deleted") lines.push("deleted file mode 100644");
  lines.push(file.status === "added" ? "--- /dev/null" : `--- a/${file.path}`);
  lines.push(file.status === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`);
  for (const h of hunks) {
    lines.push(h.header ?? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines)
      lines.push((l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.text);
  }
  return lines.join("\n") + "\n";
}

// Full-file mode (task 023, spec §18): pad the stored hunks into ONE hunk
// covering the whole file, so the same FileDiff renders everything with the
// changed lines still marked. Gap lines are ctx taken from the head file
// content (unchanged by construction); old/new counters advance per line
// type, so both columns number correctly. oldTotal derives exactly:
// newTotal − adds + dels. Pure, fixture-tested.
export function fullFileHunks(hunks, fileLines) {
  const newTotal = fileLines.length;
  if (newTotal === 0 || hunks.length === 0) return hunks; // nothing to pad
  let adds = 0, dels = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.type === "add") adds++;
      else if (l.type === "del") dels++;
    }
  const oldTotal = newTotal - adds + dels;
  const lines = [];
  let oldN = 1, newN = 1;
  const ctx = () => {
    lines.push({ type: "ctx", oldLine: oldN, newLine: newN, text: fileLines[newN - 1] });
    oldN++; newN++;
  };
  for (const h of hunks) {
    while (newN < h.newStart) ctx();
    for (const l of h.lines) {
      lines.push(l);
      if (l.type === "add") newN++;
      else if (l.type === "del") oldN++;
      else { oldN++; newN++; }
    }
  }
  while (newN <= newTotal) ctx();
  return [{
    oldStart: oldTotal === 0 ? 0 : 1, oldLines: oldTotal,
    newStart: 1, newLines: newTotal,
    lines,
  }];
}

// Chapter hunks → FileDiffMetadata (pierre's render input), or null when the
// chapter carries no textual diff (binary files).
export function fileDiffMetadata(file, hunks) {
  const text = patchText(file, hunks);
  if (!text) return null;
  return parsePatchFiles(text)[0]?.files[0] ?? null;
}

// Per-chapter split diff. `onLineNumberClick({lineNumber, annotationSide})`
// is the gutter-click consumer for the composer (M2); the selection API
// (`onSelectionChange` with SelectedLineRange) stays wired for M3 re-pin.
// Annotation hooks: renderAnnotation option + render({lineAnnotations});
// re-project the full annotation set on any state change (never mutate
// pierre state) — updateAnnotations re-renders annotation rows only.
// `marks` (M5) render as gutter glyphs via the onPostRender decoration pass
// below — not annotation rows — so a mark adds no vertical space.
// `file` is {path, status}; app.js passes {path: chapter.file, status: chapter.status}.
export function createFileDiff(file, hunks, {
  onSelectionChange,
  onSelectionEnd,
  onLineNumberClick,
  onGutterUtilityClick,
  renderAnnotation,
  annotations = [],
  marks = [],
  // pierre-native long-line handling (task 029): 'scroll' (default) keeps
  // comment annotations; 'wrap' disables them inside pierre (FileDiff sets
  // disableAnnotations when wrapping) — the UI toggle documents this
  overflow = "scroll",
} = {}) {
  const meta = fileDiffMetadata(file, hunks);
  if (!meta) return null;
  const el = document.createElement("div");
  el.className = "pierre-diff";
  const fileDiff = new FileDiff({
    diffStyle: "split",
    theme: DEFAULT_THEMES,
    disableFileHeader: true,
    overflow,
    enableLineSelection: true,
    onLineSelectionChange: onSelectionChange && ((range) => onSelectionChange(range)),
    // fires once on release with the completed range — the only event a
    // gutter drag produces (a drag across lines never fires a click, so
    // onLineNumberClick alone misses multi-line selections)
    onLineSelectionEnd: onSelectionEnd && ((range) => onSelectionEnd(range)),
    onLineNumberClick: onLineNumberClick && ((props) => onLineNumberClick(props)),
    // gutter utility (hover "#" affordance): pierre rejects combining
    // onGutterUtilityClick with renderGutterUtility — the default + button
    // plus the click callback (single line, or click-drag for a range) is
    // the intended pairing; enableGutterUtility must be explicit here
    enableGutterUtility: !!onGutterUtilityClick,
    onGutterUtilityClick: onGutterUtilityClick && ((range) => onGutterUtilityClick(range)),
    renderAnnotation: renderAnnotation && ((annotation) => renderAnnotation(annotation)),
    // marks gutter column (task 009): fires on every render — mount, update,
    // and virtualized scroll repaints — so glyphs survive windowed re-renders
    onPostRender: (container, _instance, phase) => {
      if (phase !== "unmount") stampMarks(container.shadowRoot, marks);
    },
  });
  // containerWrapper (not fileContainer): FileDiff then creates its own
  // <diffs-container> custom element, whose shadow root carries the core
  // component CSS — passing a plain div would render into an unstyled shadow
  fileDiff.render({ fileDiff: meta, lineAnnotations: annotations, containerWrapper: el });
  return { el, fileDiff, dispose: () => fileDiff.cleanUp() };
}

// Re-render annotation rows only: a fresh array instance marks annotations
// as changed, so render() skips the full-diff rebuild (diffDidChange false).
export function updateAnnotations(diff, annotations) {
  diff.fileDiff.render({ lineAnnotations: annotations });
}

// sky-eye comments (+ optional open composer) → side-aware
// DiffLineAnnotations: all entries on one line group into a single annotation
// row. Attention marks do NOT ride this projection (gutter column, task 009).
// Pure projection — fixture-tested.
export function commentAnnotations(comments, composer = null) {
  const byLine = new Map();
  const push = (skyEyeSide, line, entry) => {
    const key = `${skyEyeSide}:${line}`;
    if (!byLine.has(key))
      byLine.set(key, {
        side: skyEyeSide === "old" ? "deletions" : "additions",
        lineNumber: line,
        metadata: { comments: [], composer: null },
      });
    byLine.get(key).metadata.comments.push(entry);
  };
  for (const c of comments) push(c.side, c.line, c);
  if (composer) push(composer.side, composer.line, { composer: true });
  return [...byLine.values()];
}

// ---- attention marks: gutter glyphs (task 009) ---------------------------

const GLYPHS = { focus: "◆", glance: "▲", safe: "●" };
const COLORS = {
  focus: "var(--mark-focus)",
  glance: "var(--mark-glance)",
  safe: "var(--mark-safe)",
};

// Pure part of the gutter glyph (fixture-tested, §20): canonical mark names
// (§9.3) get glyph + color; custom classifier names (§16.5) render their
// first letter in the muted color — neutral (no canonical semantics) but
// readable, unlike the original dot (invisible in dark mode, task 013).
export function markGlyphSpec(mark) {
  const name = String(mark.mark);
  return {
    cls: name.replace(/[^a-z0-9-]/g, ""),
    glyph: GLYPHS[name] ?? (name[0] ?? "·").toUpperCase(),
    color: COLORS[name] ?? "var(--muted)",
    title: `${name} (${mark.markSource})`,
  };
}

// Inline-styled (no stylesheet injection): pierre rows live in its shadow
// root, but CSS custom properties cascade in (process.md foundations).
function markGlyph(mark) {
  const { cls, glyph, color, title } = markGlyphSpec(mark);
  const node = document.createElement("span");
  node.className = cls ? `sky-mark-glyph sky-mark-${cls}` : "sky-mark-glyph";
  node.textContent = glyph;
  node.title = title;
  node.style.cssText =
    "position:absolute;inset-block:0;left:6px;display:flex;align-items:center;" +
    `color:${color};font-weight:600;`;
  return node;
}

// Sweep-then-stamp, idempotent. Anchors to the gutter's [data-column-number]
// cell (position:relative, line number in the attribute) — pierre-internal
// structure:
// shortcut: gutter selectors are @pierre/diffs internals (pinned exact, spec
// §2); re-verify against a rendered diff when bumping @pierre/diffs —
// upgrade path is a native pierre gutter-annotation API.
function stampMarks(root, marks) {
  if (!root) return;
  for (const old of root.querySelectorAll(".sky-mark-glyph")) old.remove();
  for (const m of marks) {
    const cell = root.querySelector(
      `code[data-${m.side === "old" ? "deletions" : "additions"}] [data-column-number="${m.line}"]`,
    );
    if (cell) cell.append(markGlyph(m));
  }
}

// (Comment-row styling lives in style.css: pierre appends annotation rows
// to the diffs-container's LIGHT DOM and slots them into its shadow root,
// so document styles apply — see queryComment below.)

// Read-only file view for the explorer (replaces the hand-rolled file pane).
// Async: File only paints its rows when the shared highlighter already has
// the file's language — pierre defers to an async highlight when it isn't,
// and that deferred re-render is swallowed by the "nothing changed" render
// short-circuit (diffs 1.6.4), leaving an empty container (task 015).
// Chapter FileDiff is unaffected: it paints plain rows first, then
// re-tokenizes in place.
export async function createFileView(path, contents) {
  const lang = getFiletypeFromFileName(path) ?? "text";
  await initPierre();
  await getSharedHighlighter({
    themes: [DEFAULT_THEMES.light, DEFAULT_THEMES.dark], langs: [lang],
    preferredHighlighter: "shiki-js",
  });
  const el = document.createElement("div");
  el.className = "pierre-file";
  const file = new File({ theme: DEFAULT_THEMES, disableFileHeader: true });
  file.render({ file: { name: path, contents }, containerWrapper: el });
  return { el, dispose: () => file.cleanUp() };
}

// Explorer tree (spec §18.3): search + git-status badges. `paths` must be
// repo-relative; `changed` maps chapter statuses onto GitStatusEntry.
// Theming: the tree renders inside a shadow root, so its --trees-theme-*
// variables are applied to the host element via themeToTreeStyles, resolved
// through the same theme the diffs use so diff and tree colors agree.
let treeThemeStyle = null;
function treeTheme() {
  if (treeThemeStyle === null) {
    try {
      treeThemeStyle = themeToTreeStyles(resolveTheme("pierre-light"));
    } catch {
      treeThemeStyle = ""; // theme not resolvable yet — tree falls back to its defaults
    }
  }
  return treeThemeStyle;
}

export function createFileTree({ paths, changed = [], onOpen }) {
  const el = document.createElement("div");
  el.className = "pierre-tree";
  const tree = new FileTree({
    paths,
    search: true,
    initialExpansion: "open",
    // chapters span files (spec §9.3): git-status entries come from the
    // per-file slices, not the chapter
    gitStatus: changed
      .flatMap((c) => c.files.map((s) => ({ path: s.file, status: s.status })))
      .filter((e) => e.path),
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      // dirs arrive selected too; only files open a view
      if (path && onOpen && !path.endsWith("/")) onOpen(path);
    },
  });
  tree.render({ containerWrapper: el });
  el.style.cssText = treeTheme();
  return { el, tree, dispose: () => tree.cleanUp() };
}

// SelectedLineRange / gutter-click props → sky-eye anchor side ('old'|'new')
// for M2/M3 flows. `annotationSide` comes from onLineNumberClick; `side` from
// SelectedLineRange.
export function selectionSide({ side, annotationSide } = {}) {
  return (side ?? annotationSide) === "deletions" ? "old" : "new";
}

// Locate a rendered diff row inside the shadow root for deep links: rows carry
// data-line (their own side's number) and data-alt-line (the other side's).
export function queryRow(diff, side, line) {
  const root = diff?.el.querySelector("diffs-container")?.shadowRoot;
  if (!root) return null;
  const column = side === "old" ? "deletions" : "additions";
  return (
    root.querySelector(`code[data-${column}] [data-line="${line}"]`) ??
    root.querySelector(`[data-line="${line}"], [data-alt-line="${line}"]`)
  );
}

// Locate our comment row for deep links. Annotation rows are LIGHT-DOM
// children of the diffs-container (FileDiff.renderAnnotations appends them
// to fileContainer, then slots them into its shadow root) — so they are
// styled by the document stylesheet and found by a plain querySelector.
export function queryComment(diff, commentId) {
  const container = diff?.el.querySelector("diffs-container");
  return container?.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) ?? null;
}
