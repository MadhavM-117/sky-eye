// The ONLY module importing @pierre/* (spec §18, spec §2 isolation rule).
// Server JSON in → pierre render input out; pierre events back → app
// callbacks. Pure projection: no app state is stored in pierre model
// objects; callers re-render by re-projecting, never by mutating pierre
// model state.
import {
  File,
  FileDiff,
  DEFAULT_THEMES,
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
// `file` is {path, status}; app.js passes {path: chapter.file, status: chapter.status}.
export function createFileDiff(file, hunks, {
  onSelectionChange,
  onLineNumberClick,
  onGutterUtilityClick,
  renderAnnotation,
  annotations = [],
} = {}) {
  const meta = fileDiffMetadata(file, hunks);
  if (!meta) return null;
  const el = document.createElement("div");
  el.className = "pierre-diff";
  const fileDiff = new FileDiff({
    diffStyle: "split",
    theme: DEFAULT_THEMES,
    disableFileHeader: true,
    enableLineSelection: true,
    onLineSelectionChange: onSelectionChange && ((range) => onSelectionChange(range)),
    onLineNumberClick: onLineNumberClick && ((props) => onLineNumberClick(props)),
    // gutter utility (hover "#" affordance): pierre rejects combining
    // onGutterUtilityClick with renderGutterUtility — the default + button
    // plus the click callback (single line, or click-drag for a range) is
    // the intended pairing; enableGutterUtility must be explicit here
    enableGutterUtility: !!onGutterUtilityClick,
    onGutterUtilityClick: onGutterUtilityClick && ((range) => onGutterUtilityClick(range)),
    renderAnnotation: renderAnnotation && ((annotation) => renderAnnotation(annotation)),
  });
  // containerWrapper (not fileContainer): FileDiff then creates its own
  // <diffs-container> custom element, whose shadow root carries the core
  // component CSS — passing a plain div would render into an unstyled shadow
  fileDiff.render({ fileDiff: meta, lineAnnotations: annotations, containerWrapper: el });
  commentStyleSheet(el);
  return { el, fileDiff, dispose: () => fileDiff.cleanUp() };
}

// Re-render annotation rows only: a fresh array instance marks annotations
// as changed, so render() skips the full-diff rebuild (diffDidChange false).
export function updateAnnotations(diff, annotations) {
  diff.fileDiff.render({ lineAnnotations: annotations });
}

// sky-eye comments (+ optional open composer) → side-aware
// DiffLineAnnotations: all comments on one line group into a single
// annotation row. Pure projection — fixture-tested.
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

// Inject app styles for our annotation rows into the shadow root (pierre
// renders annotations inside its own shadow DOM; document CSS can't reach
// them, but CSS custom properties from :root do inherit).
const commentStyle = `
.sky-comment-row { display: flex; flex-direction: column; gap: 6px;
  padding: 6px 10px 10px; font: 13px/1.5 var(--font-sans, system-ui);
  color: var(--fg, #1f2328); background: var(--header-bg, #f6f8fa);
  border-bottom: 1px solid var(--border, #d0d7de); }
.sky-comment { border: 1px solid var(--border, #d0d7de);
  border-radius: 6px; background: var(--bg, #fff); padding: 6px 10px; }
.sky-comment.resolved { opacity: 0.7; }
.sky-comment-head { display: flex; gap: 8px; align-items: baseline;
  font-size: 12px; color: var(--muted, #59636e); margin-bottom: 2px; }
.sky-comment-head .author { font-weight: 600; color: var(--fg, #1f2328); }
.sky-comment-text { white-space: pre-wrap; }
.sky-chip { border-radius: 999px; padding: 0 7px; font-size: 11px;
  background: var(--add-bg, #dafbe1); }
.sky-comment-actions { margin-left: auto; display: flex; gap: 8px; }
.sky-comment-actions button { font-size: 12px; padding: 1px 7px; }
.sky-comment textarea, .sky-composer textarea { width: 100%;
  font: 13px/1.5 var(--font-sans, system-ui); padding: 6px;
  border: 1px solid var(--border, #d0d7de); border-radius: 6px;
  resize: vertical; }
.sky-composer { display: flex; flex-direction: column; gap: 6px; }
.sky-composer-actions { display: flex; gap: 8px; align-items: center; }
.sky-composer-actions button { font-size: 12px; padding: 2px 10px; }
.sky-composer-actions .submit { font-weight: 600; }
.sky-composer-actions select { font-size: 12px; padding: 1px 6px; }
.sky-flash { animation: sky-flash 1.2s ease-out; }
@keyframes sky-flash { 0% { background: var(--warning, #ffd452); }
  100% { background: transparent; } }
`;

function commentStyleSheet(el) {
  const root = el.querySelector("diffs-container")?.shadowRoot;
  if (!root) return;
  if (!root.adoptedStyleSheets.some((s) => s._skyEye)) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(commentStyle);
    sheet._skyEye = true;
    root.adoptedStyleSheets.push(sheet);
  }
}

// Read-only file view for the explorer (replaces the hand-rolled file pane).
export function createFileView(path, contents) {
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
    gitStatus: changed.map((c) => ({ path: c.file, status: c.status })),
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

// Locate our comment row inside the shadow root (data-comment-id set by the
// renderAnnotation callback in comments.js).
export function queryComment(diff, commentId) {
  const root = diff?.el.querySelector("diffs-container")?.shadowRoot;
  return root?.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) ?? null;
}
