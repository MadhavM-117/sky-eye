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

// Per-chapter split diff. `onSelectionChange(range | null)` receives
// SelectedLineRange ({start, end, side: 'deletions'|'additions'}) from
// pierre's selection API — gutter-click consumer lives in M2 (composer).
// Annotation hooks for M2/M5 confirmed: renderAnnotation option and
// setLineAnnotations() on the returned fileDiff; re-project the full
// annotation set on any state change (never mutate pierre state).
// `file` is {path, status}; app.js passes {path: chapter.file, status: chapter.status}.
export function createFileDiff(file, hunks, { onSelectionChange } = {}) {
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
  });
  // containerWrapper (not fileContainer): FileDiff then creates its own
  // <diffs-container> custom element, whose shadow root carries the core
  // component CSS — passing a plain div would render into an unstyled shadow
  fileDiff.render({ fileDiff: meta, containerWrapper: el });
  return { el, fileDiff, dispose: () => fileDiff.cleanUp() };
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

// SelectedLineRange → sky-eye anchor side ('old'|'new'), for M2/M3 flows.
export function selectionSide(range) {
  return range?.side === "deletions" ? "old" : "new";
}
