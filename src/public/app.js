// Hash router + first screen + session view (spec §18, U§1.5, U§3).
// Comments (M2, design A): inline annotation rows under the clicked line,
// rendered through pierre's annotation framework via the adapter.
import { get, mut } from "./api.js";
import {
  commentAnnotations,
  createFileDiff,
  fullFileHunks,
  initPierre,
  queryComment,
  queryRow,
  selectionSide,
  updateAnnotations,
} from "./pierre-adapter.js";
import { commentNode, composerNode } from "./comments.js";
import { mdToHtml } from "./markdown.js";

// highlighter must be loaded before FileDiff renders anything; await it
// (best-effort: if it fails, diffs falls back to unhighlighted text)
const pierreReady = initPierre().catch(() => {});
import { renderExplorer } from "./explorer.js";

const app = document.getElementById("app");

// one-chapter-at-a-time view (ux §3.3): module state that survives re-
// renders within a session — active chapter, rail collapse, pending
// orphan-triage re-pin; reset on session switch in render()
let activeChapterId = null;
let activeSid = null;
let railCollapsed = false;
let pendingTriage = null;

// viewed state (task 021, spec §9.3): persisted per (chapter, file) slice via
// PATCH viewedFiles; "chapter viewed" is derived (every slice listed). Collapse
// is ephemeral UI state — explicit open/closed overrides, cleared on session
// switch. At render time: override ?? viewed (viewed renders collapsed).
let openOverrides = new Map(); // key `chapterId\0file` → true=open, false=manually closed
const viewedKey = (chapterId, file) => `${chapterId}\u0000${file}`;
// full-file mode (task 023, spec §18): also ephemeral per session — which
// blocks render the padded whole file instead of the diff
const fullFileMode = new Set(); // same keys as openOverrides
const isFullFile = (chapterId, file) => fullFileMode.has(viewedKey(chapterId, file));
const isViewed = (c, file) => (c.viewedFiles ?? []).includes(file);
const chapterViewed = (c) => c.files.every((s) => isViewed(c, s.file));

// hash forms (spec §17): "" | "#<sid>" | "#<sid>/<commentId>"
//   | "#<sid>/<chapterId>/<encFile>/<line>" | "#<sid>/explorer/<encPath>§<side>"
// (paths are percent-encoded, so no raw slashes inside the encoded part)
function parseHash() {
  const h = location.hash.slice(1);
  const idx = h.indexOf("/explorer/");
  if (idx > 0) {
    const sid = h.slice(0, idx);
    // URL bars percent-encode §, so accept both spellings for the separator
    const rest = h.slice(idx + "/explorer/".length).replace(/%C2%A7/g, "§");
    const sep = rest.indexOf("§");
    const encPath = sep === -1 ? rest : rest.slice(0, sep);
    const side = sep === -1 || !rest.slice(sep + 1) ? "head" : rest.slice(sep + 1);
    return { view: "explorer", sid, path: decodeURIComponent(encPath), side };
  }
  if (!h) return { view: "first" };
  const parts = h.split("/");
  if (parts.length === 4)
    return {
      view: "session",
      sid: parts[0],
      chapterId: parts[1],
      file: decodeURIComponent(parts[2]),
      line: Number(parts[3]),
      target: "line",
    };
  // second segment: a comment id, else a chapter id (scroll to chapter)
  return { view: "session", sid: parts[0], target: parts.length > 1 ? parts[1] : null };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

window.addEventListener("hashchange", render);
render();

async function render() {
  await pierreReady;
  const route = parseHash();
  try {
    if (route.view === "first") return await renderFirst();
    if (route.view === "explorer") {
      const session = await get(`/api/sessions/${encodeURIComponent(route.sid)}`);
      return renderExplorer(app, session, route, () => {
        location.hash = `#${route.sid}`;
      });
    }
    const session = await get(`/api/sessions/${encodeURIComponent(route.sid)}`);
    if (activeSid !== route.sid) {
      activeSid = route.sid;
      activeChapterId = null;
      pendingTriage = null;
      openOverrides.clear(); // fresh session → fresh collapse defaults
      fullFileMode.clear();
    }
    renderSession(session, route);
  } catch (e) {
    app.innerHTML = `<div class="banner error">error: ${esc(e?.error ?? e?.message ?? e)}</div>
      <a href="#">← back to the first screen</a>`;
  }
}

function shell(title, inner) {
  app.innerHTML = `<div class="frame">${inner}</div>`;
  document.title = title;
}

// ---- first screen ------------------------------------------------------

async function renderFirst() {
  const [refs, sessions, archived] = await Promise.all([
    get("/api/refs"),
    get("/api/sessions"),
    get("/api/sessions?archived=1"),
  ]);

  const opt = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
  const groups = [];
  if (refs.defaultBase)
    groups.push(
      `<optgroup label="default base">${opt(refs.defaultBase.id, `${refs.defaultBase.label} (${short(refs.defaultBase.id)})`)}</optgroup>`,
    );
  const group = (name, list) =>
    list.length
      ? `<optgroup label="${name}">${list.map((b) => opt(b.id, `${b.name} (${short(b.id)})`)).join("")}</optgroup>`
      : "";
  groups.push(group("bookmarks", refs.branches));
  groups.push(
    group("recent commits", refs.commits.map((c) => ({ id: c.id, name: `${short(c.id)} ${c.subject}` }))),
  );
  const headLabel = refs.head.label ?? short(refs.head.id);

  shell("sky-eye", `
    <header>
      <h1>sky-eye</h1>
      <span class="badge">${refs.kind} repo</span>
      <span class="repo-path">${esc(refs.root)}</span>
    </header>
    <section class="picker">
      Review <strong>${esc(headLabel)}</strong> against
      <select id="base">${refs.defaultBase ? "" : ""}${groups.join("")}</select>
      <button id="create">Create review</button>
      ${refs.defaultBase || refs.branches.length || refs.commits.length ? "" : `<p class="empty">no base candidates found in this repo</p>`}
    </section>
    <section class="sessions">
      <h2>Sessions <button id="import">import</button><input type="file" id="import-file" accept="application/json" hidden/></h2>
      ${sessions.length === 0 ? `<p class="empty">no sessions yet</p>` : `<ul class="session-list">${sessions.map((s) => `
        <li><a href="#${esc(s.id)}">
          <span class="label">${esc(s.label ?? s.id)}</span>
          ${s.aliases.length ? `<span class="aliases">${esc(s.aliases.join(" "))}</span>` : ""}
          ${s.reviewed ? `<span class="chip reviewed">reviewed</span>` : ""}
          <span class="meta">${s.openComments} open · ${new Date(s.updatedAt).toLocaleString()}</span>
        </a></li>`).join("")}</ul>`}
    </section>
    ${archived.length ? `
    <section class="archived">
      <h2><button id="archive-toggle">archived (${archived.length}) ▾</button></h2>
      <ul class="session-list" id="archive-list" hidden>${archived.map((s) => `
        <li><span class="label">${esc(s.label ?? s.id)}</span>
          <span class="meta">${new Date(s.updatedAt).toLocaleString()}</span>
          <button class="unarchive" data-id="${esc(s.id)}" title="back into the session list">restore</button>
          <button class="delete-archived" data-id="${esc(s.id)}">delete</button>
        </li>`).join("")}</ul>
    </section>` : ""}`);

  document.getElementById("create").onclick = async () => {
    const base = document.getElementById("base").value;
    if (!base) return;
    // labels for aliases: resolve the name for the chosen id
    const label =
      refs.branches.find((b) => b.id === base)?.name ??
      (refs.defaultBase?.id === base ? refs.defaultBase.label : undefined);
    // semantic chunking (§8a) + eager analysis (§16.2) make creation slow —
    // spinner + banner instead of a dead button (same pattern as rerun-all)
    // shortcut: indeterminate progress only — live per-chapter progress when
    // creation latency annoys (spec §16.2, ux §1.5)
    const btn = document.getElementById("create");
    btn.disabled = true;
    btn.textContent = "creating…";
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.innerHTML = '<span class="spinner"></span> analyzing diff into chapters…';
    document.querySelector(".picker")?.insertAdjacentElement("afterend", banner);
    try {
      const s = await mut("POST", "/api/sessions", {
        base,
        head: refs.head.id,
        baseLabel: label,
        headLabel: refs.head.label ?? undefined,
      });
      location.hash = `#${s.id}`;
    } catch (e) {
      alert(e?.error ?? "could not create session");
    } finally {
      banner.remove();
      btn.disabled = false;
      btn.textContent = "Create review";
    }
  };

  // archived reviews (task 017): collapsed until expanded; restore puts the
  // review back into the session list, delete is permanent
  const archiveToggle = document.getElementById("archive-toggle");
  if (archiveToggle)
    archiveToggle.onclick = () => {
      const list = document.getElementById("archive-list");
      list.hidden = !list.hidden;
      archiveToggle.textContent =
        `archived (${archived.length}) ${list.hidden ? "▾" : "▴"}`;
    };
  for (const btn of document.querySelectorAll("button.unarchive"))
    btn.onclick = async () => {
      try {
        await mut("POST", `/api/sessions/${encodeURIComponent(btn.dataset.id)}/unarchive`);
        renderFirst();
      } catch (e) {
        alert(e?.error ?? "could not restore");
      }
    };
  for (const btn of document.querySelectorAll("button.delete-archived"))
    btn.onclick = async () => {
      if (!confirm("delete this review permanently?")) return;
      try {
        await mut("DELETE", `/api/sessions/${encodeURIComponent(btn.dataset.id)}`);
        renderFirst();
      } catch (e) {
        alert(e?.error ?? "could not delete");
      }
    };

  // import (§14): pick an exported session file → merged into the session
  // with the same id (or created), then open it
  const fileInput = document.getElementById("import-file");
  document.getElementById("import").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = ""; // re-selecting the same file must re-fire change
    try {
      const s = await mut("POST", "/api/import", JSON.parse(await file.text()));
      location.hash = `#${s.id}`;
    } catch (e) {
      alert(e?.error ?? "could not import");
    }
  };
}

const short = (id) => (id.length > 12 ? id.slice(0, 12) : id);

// ---- session view ------------------------------------------------------

// changed-line counts per slice / per chapter (rail + chapter head)
const sliceStats = (s) =>
  s.hunks.reduce(
    ([a, d], h) => [
      a + h.lines.filter((l) => l.type === "add").length,
      d + h.lines.filter((l) => l.type === "del").length,
    ],
    [0, 0],
  );
const chapterStats = (c) => {
  const out = [c.files.length, 0, 0];
  for (const s of c.files) {
    const [a, d] = sliceStats(s);
    out[1] += a;
    out[2] += d;
  }
  return out;
};
const statsHtml = (add, del) =>
  `${del || !add ? `<span class="del">−${del}</span> ` : ""}<span class="add">+${add}</span>`;

function renderSession(session, route = null) {
  // deep links (§17) open the owning chapter: a line target names it, a
  // comment target rides the comment's chapterId, a chapter target is it
  let target = null;
  if (route?.target === "line") target = route.chapterId;
  else if (route?.target) {
    const c = session.comments.find((c) => c.id === route.target);
    if (c) target = c.chapterId;
    else if (session.chapters.some((ch) => ch.id === route.target)) target = route.target;
  }
  if (target && session.chapters.some((c) => c.id === target)) activeChapterId = target;
  const active =
    session.chapters.find((c) => c.id === activeChapterId) ?? session.chapters[0];
  activeChapterId = active?.id ?? null;

  const headLabel = session.headRef ?? short(session.head);
  const baseLabel = session.baseRef ?? short(session.base);
  const openCount = session.comments.filter((c) => !c.resolved).length;
  const title = displayTitle(session);

  // the body renders one chapter (ux §3.3); the rail is the navigation
  const chaptersHtml = active
    ? chapterHtml(session, active, session.chapters.indexOf(active))
    : `<p class="empty">nothing to review for this comparison</p>`;

  // three-line header (task 022, ux §3.1): title / context / actions —
  // each row keeps its own kind of information; primary actions visible,
  // the rest in a "more" overflow menu; hover titles carry the side effects
  shell(title, `
    <header class="session-header">
      <div class="h-row h-title">
        <a href="#">sky-eye</a>
        <span class="session-title" id="session-label" title="click to rename">${esc(title)}</span>
        <button class="title-edit" title="edit review title">✎</button>
        <span class="badge">${badge(session)}</span>
        <span class="aliases">${esc(session.aliases.join(" "))}</span>
        <span class="meta" id="open-count">${openCount} open comments</span>
      </div>
      <div class="h-row h-context">
        <span class="repo-path" title="repository under review">${esc(session.meta.repo)}</span>
        <span class="meta">${headLabel} → ${baseLabel}</span>
      </div>
      <div class="h-row h-actions">
        <button id="mark-reviewed" class="${session.reviewed ? "marked" : ""}" title="${session.reviewed ? "this review is marked reviewed — click to unmark" : "mark this review as reviewed"}">${session.reviewed ? "✓ reviewed" : "mark reviewed"}</button>
        <a class="explorer-link" href="#${esc(session.id)}/explorer/§head" title="browse the repository's files">files</a>
        <!-- export (§14): a plain link — the route's Content-Disposition triggers the download -->
        <a class="explorer-link" href="/api/sessions/${encodeURIComponent(session.id)}/export" title="download this review as JSON">export</a>
        <details class="more-menu">
          <summary title="more actions">more ▾</summary>
          <div class="menu">
            <button id="rerun-all" title="re-generate marks + narratives for every chapter (overwrites edited narratives)">regenerate all</button>
            <button id="rechunk" title="re-run the chapter grouping on the stored diff (chapter ids may move)">re-group</button>
            <button id="archive" title="move out of the session list — restorable from the first screen">archive</button>
            <button id="delete-review" title="delete this review permanently">delete</button>
          </div>
        </details>
      </div>
    </header>
    ${bannersHtml(session)}
    <div class="session-layout">
      ${railHtml(session)}
      <div class="chapters">${chaptersHtml}</div>
    </div>`);

  wireSession(session, route);
}

// chapter rail (ux §3.3): title, one-line narrative description, change
// summary; the active row nests the chapter's file list
function railHtml(session) {
  const rows = session.chapters
    .map((c, i) => {
      const [files, add, del] = chapterStats(c);
      const active = c.id === activeChapterId;
      const desc =
        !c.narrative || c.narrative === "unanalyzed"
          ? "unanalyzed"
          : (c.narrative.split("\n").find((l) => l.trim()) ?? "unanalyzed");
      const fileList = active
        ? `<ul class="rail-files">${c.files
            .map((s) => {
              const [sa, sd] = sliceStats(s);
              const viewed = isViewed(c, s.file);
              return `<li data-file="${esc(s.file)}" title="scroll to this file's diff"><span class="viewed">${viewed ? "✓" : ""}</span><span class="status ${s.status}">${s.status}</span><span class="rail-file-path">${esc(s.file)}</span><span class="stats"><span class="add">+${sa}</span> <span class="del">−${sd}</span></span></li>`;
            })
            .join("")}</ul>`
        : "";
      return `<div class="rail-row${active ? " active" : ""}" data-chapter="${c.id}">
        <div class="rail-title">${chapterViewed(c) ? '<span class="viewed">✓</span> ' : ""}chapter ${i + 1}${c.title ? `: ${esc(c.title)}` : ""}</div>
        <div class="rail-desc">${esc(desc)}</div>
        <div class="rail-meta">${files} file${files === 1 ? "" : "s"} · <span class="add">+${add}</span> <span class="del">−${del}</span></div>
        ${fileList}
      </div>`;
    })
    .join("");
  return `<aside class="rail${railCollapsed ? " collapsed" : ""}">
    <div class="rail-head"><span>chapters</span><button id="rail-toggle" title="collapse / expand the chapter rail">${railCollapsed ? "▸" : "◂"}</button></div>
    ${rows}
  </aside>`;
}

// scroll to + flash a target; retries while pierre's lazy grammar loading
// re-renders rows after the first pass (deep links §17, rail file clicks)
function scrollFlash(find) {
  let tries = 0;
  const tick = () => {
    const target = find();
    if (target) {
      target.scrollIntoView({ block: "center" });
      // Web Animations instead of a CSS class: pierre's diff rows live in
      // its shadow root, where our stylesheet doesn't reach
      target.animate?.(
        [{ backgroundColor: "var(--warning, #ffd452)" }, { backgroundColor: "transparent" }],
        { duration: 1200, easing: "ease-out" },
      );
      return;
    }
    if (++tries < 20) setTimeout(tick, 100);
  };
  tick();
}

const copyLink = (fragment) => {
  const url = location.href.split("#")[0] + "#" + fragment;
  navigator.clipboard.writeText(url).catch(() => alert(url));
};

const handleMutError = (e) => {
  if (e?.status === 409) {
    if (confirm("session changed elsewhere — reload?")) location.reload();
    return;
  }
  alert(e?.error ?? "could not save");
};

const badge = (session) =>
  session.meta.repo.split("/").slice(-1)[0] + " review";

// Title: the stored label when set; default is the review order
// "<current branch> → <base branch>" (feedback on task 023), raw id only
// when branch names are unknown
const displayTitle = (s) => {
  if (s.label) return s.label;
  if (s.headRef && s.baseRef) return `${s.headRef} → ${s.baseRef}`;
  return s.id;
};

// stale / superseded / orphan-triage banners (spec §13, U§3.1)
function bannersHtml(session) {
  const orphans = session.comments.filter((c) => c.orphaned && !c.resolved);
  const out = [];
  if (session.supersededBy)
    out.push(
      `<div class="banner">this review was superseded — <a href="#${esc(session.supersededBy)}">open the successor</a></div>`,
    );
  else if (session.stale)
    out.push(
      `<div class="banner">review is stale — the underlying diff changed <button id="refresh">refresh review</button></div>`,
    );
  if (orphans.length)
    out.push(`<div class="banner triage" id="triage"></div>`);
  return out.join("");
}

const triageItem = (c) => `
  <div class="triage-item" data-comment="${esc(c.id)}">
    <span class="triage-text">“${esc(c.text)}”</span>
    <span class="meta">was ${esc(c.file)}:${c.line}</span>
    <button class="triage-repin" data-comment="${esc(c.id)}">re-pin</button>
    <button class="triage-resolve" data-comment="${esc(c.id)}">resolve</button>
  </div>`;

function chapterHtml(session, c, index) {
  const [, add, del] = chapterStats(c);
  // a chapter may span files (spec §9.3): one diff block per file slice, each
  // an accordion with a viewed checkbox (task 021) — viewed defaults to
  // collapsed unless an explicit open override says otherwise
  const blocks = c.files
    .map((s) => {
      const key = viewedKey(c.id, s.file);
      const open = openOverrides.has(key) ? openOverrides.get(key) : !isViewed(c, s.file);
      // the whole bar is the accordion toggle (ux §3.2); only the viewed
      // checkbox and the full-file button are exempt. Deleted files have no
      // head content to pad from → no full-file mode.
      const full = isFullFile(c.id, s.file) && s.status !== "deleted";
      return `
      <h3 class="file-head" data-chapter="${esc(c.id)}" data-file="${esc(s.file)}" title="click to collapse / expand">
        <span class="file-chevron">${open ? "▾" : "▸"}</span>
        <span class="file-path">${esc(s.file)}</span>
        <span class="status ${s.status}">${s.status}</span>
        <label class="viewed-toggle"><input type="checkbox" class="file-viewed"
          data-chapter="${esc(c.id)}" data-file="${esc(s.file)}"
          ${isViewed(c, s.file) ? "checked" : ""}/> viewed</label>
        ${s.status === "deleted" ? "" : `<button class="file-full" data-chapter="${esc(c.id)}" data-file="${esc(s.file)}" title="${full ? "back to the diff" : "render the whole file (any line commentable)"}">${full ? "diff view" : "full file"}</button>`}
      </h3>
      <div class="diff-holder" data-chapter="${c.id}" data-file="${esc(s.file)}"
        ${open ? "" : "hidden"}></div>`;
    })
    .join("");
  return `
  <section class="chapter" data-chapter="${c.id}">
    <h2 class="chapter-head">
      <button class="chapter-prev" title="previous chapter" ${index === 0 ? "disabled" : ""}>◀</button>
      <button class="chapter-next" title="next chapter" ${index === session.chapters.length - 1 ? "disabled" : ""}>▶</button>
      <span class="chapter-title">chapter ${index + 1}${c.title ? `: ${esc(c.title)}` : ""}</span>
      <span class="stats">${statsHtml(add, del)}</span>
      <label class="viewed-toggle"><input type="checkbox" class="chapter-viewed"
        data-chapter="${esc(c.id)}" ${chapterViewed(c) ? "checked" : ""}/> viewed</label>
      <button class="narr-edit" data-i="${index}" title="edit narrative">✎ edit</button>
      <button class="rerun" data-i="${index}" title="re-generate narrative + marks">↻</button>
    </h2>
    <div class="chapter-body">
      <div class="narrative-box" data-chapter="${c.id}">
        <div class="narrative-view">${narrativeViewHtml(c)}</div>
        <textarea class="narrative" hidden rows="4"></textarea>
        <div class="narrative-load" hidden><span class="spinner"></span> analyzing…</div>
        <div class="narrative-actions" hidden>
          <button class="narr-save">save</button>
          <button class="narr-cancel">cancel</button>
        </div>
      </div>
      ${blocks}
    </div>
  </section>`;
}

// narrative as read view: rendered markdown; "unanalyzed"/empty shows a
// placeholder instead (markdown stored verbatim in the session, §18)
function narrativeViewHtml(c) {
  if (!c.narrative || c.narrative === "unanalyzed")
    return `<span class="placeholder">not analyzed yet — the AI summary appears here</span>`;
  return mdToHtml(c.narrative);
}

function wireSession(session, route = null) {
  let current = session;
  // one composer at a time (design A); diffs holds pierre instances per chapter
  const composer = { state: null };
  const diffs = new Map();

  const refetch = async () => {
    current = await get(`/api/sessions/${encodeURIComponent(current.id)}`);
    const el = document.getElementById("open-count");
    if (el)
      el.textContent = `${current.comments.filter((c) => !c.resolved).length} open comments`;
    refreshAll();
    renderTriage();
    return current;
  };
  const refreshAll = () => {
    for (const [key, inst] of diffs) {
      const [chapterId, file] = key.split("\u0000");
      const chapter = current.chapters.find((c) => c.id === chapterId);
      if (chapter) updateAnnotations(inst, annotationsFor(chapter, file));
    }
  };
  // does the slice render this line? (new side / old side ranges)
  const lineInSlice = (chapter, file, side, line) => {
    const s = chapter.files.find((x) => x.file === file);
    return (
      !!s &&
      s.hunks.some((h) =>
        side === "old"
          ? line >= h.oldStart && line < h.oldStart + h.oldLines
          : line >= h.newStart && line < h.newStart + h.newLines,
      )
    );
  };

  // annotations are per file slice inside a chapter (task 009); attention
  // marks (M5) do not ride this projection — the adapter stamps them into
  // the gutter via onPostRender (task 009), fed per file slice below.
  // Unchanged-line comments (§13.3.5) sit outside every hunk — only visible
  // in full-file mode, where the whole file renders (spec §18).
  const annotationsFor = (chapter, file) =>
    commentAnnotations(
      current.comments.filter((c) => {
        if (c.chapterId !== chapter.id || c.file !== file) return false;
        return isFullFile(chapter.id, file) || lineInSlice(chapter, file, c.side, c.line);
      }),
      composer.state?.chapterId === chapter.id && composer.state.file === file
        ? composer.state
        : null,
    );

  const postComment = async (chapter, file, text, priority) => {
    if (!text.trim()) return;
    const state = composer.state;
    composer.state = null;
    try {
      await mut("POST", "/api/comments", {
        sessionId: current.id,
        chapterId: chapter.id,
        file,
        side: state.side,
        line: state.line,
        text,
        priority: priority || undefined,
        lastWriteAt: current.lastWriteAt,
      });
      await refetch();
    } catch (e) {
      handleMutError(e);
      composer.state = state; // keep the draft on failure
      refreshAll();
    }
  };
  const patchComment = async (comment, body) => {
    try {
      await mut("PATCH", `/api/comments/${encodeURIComponent(comment.id)}`, {
        sessionId: current.id,
        lastWriteAt: current.lastWriteAt,
        ...body,
      });
      await refetch();
    } catch (e) {
      handleMutError(e);
      refreshAll(); // restore the row from server truth
    }
  };

  // viewed state (task 021): one PATCH replaces the chapter's list, server
  // intersects with slice paths; full re-render updates rail glyphs,
  // checkboxes and chevrons together
  const patchViewed = async (chapter, files) => {
    try {
      current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
        lastWriteAt: current.lastWriteAt,
        viewedFiles: { chapterId: chapter.id, files },
      });
      renderSession(current);
    } catch (e) {
      handleMutError(e);
    }
  };

  // un-hide a (possibly viewed → collapsed) block before scroll+flash: a
  // hidden holder cannot be flashed. Marks an explicit open override so the
  // unmark-viewed flow keeps the block open.
  const forceOpen = (chapterId, file) => {
    openOverrides.set(viewedKey(chapterId, file), true);
    const h = [...document.querySelectorAll(".diff-holder")].find(
      (x) => x.dataset.chapter === chapterId && x.dataset.file === file,
    );
    if (h) {
      h.hidden = false;
      const ch = h.previousElementSibling?.querySelector(".file-chevron");
      if (ch) ch.textContent = "▾";
    }
    return h;
  };

  // per-file accordion (task 023, ux §3.2): the WHOLE bar toggles collapse —
  // only the viewed checkbox and the full-file button are exempt click
  // targets. Ephemeral: unmarking viewed does not auto-expand (the explicit
  // override survives).
  document.querySelectorAll(".file-head").forEach((head) => {
    head.onclick = (ev) => {
      if (ev.target.closest(".viewed-toggle") || ev.target.closest(".file-full")) return;
      const key = viewedKey(head.dataset.chapter, head.dataset.file);
      const holder = head.nextElementSibling;
      const nowOpen = !holder.hidden;
      openOverrides.set(key, !nowOpen);
      holder.hidden = nowOpen;
      head.querySelector(".file-chevron").textContent = nowOpen ? "▸" : "▾";
    };
  });

  // viewed toggles: per file and per chapter (chapter = replace with all
  // slice paths — the two rule directions hold by construction, §9.3)
  document.querySelectorAll(".file-viewed").forEach((cb) => {
    cb.onchange = () => {
      const chapter = current.chapters.find((c) => c.id === cb.dataset.chapter);
      if (!chapter) return;
      const viewed = chapter.viewedFiles ?? [];
      if (cb.checked) {
        openOverrides.set(viewedKey(chapter.id, cb.dataset.file), false); // collapse immediately
        patchViewed(chapter, [...new Set([...viewed, cb.dataset.file])]);
      } else {
        patchViewed(chapter, viewed.filter((f) => f !== cb.dataset.file));
      }
    };
  });
  document.querySelectorAll(".chapter-viewed").forEach((cb) => {
    cb.onchange = () => {
      const chapter = current.chapters.find((c) => c.id === cb.dataset.chapter);
      if (!chapter) return;
      if (cb.checked)
        for (const s of chapter.files)
          openOverrides.set(viewedKey(chapter.id, s.file), false); // collapse all
      patchViewed(chapter, cb.checked ? chapter.files.map((s) => s.file) : []);
    };
  });

  // annotation row for one diff line: stored comments + optional composer
  const annotationRow = (annotation, chapter, file) => {
    const row = document.createElement("div");
    row.className = "sky-comment-row";
    for (const entry of annotation.metadata.comments) {
      if (entry.composer) {
        row.append(
          composerNode(composer.state, {
            onSubmit: (text, priority) => postComment(chapter, file, text, priority),
            onCancel: () => {
              composer.state = null;
              refreshAll();
            },
          }),
        );
      } else {
        row.append(
          commentNode(entry, {
            onResolve: (comment, resolved) => patchComment(comment, { resolved }),
            onEdit: (comment, text) => patchComment(comment, { text }),
            onCopy: (comment) => copyLink(`#${current.id}/${comment.id}`),
          }),
        );
      }
    }
    return row;
  };

  // one diff block per file slice inside a chapter (task 009); extracted so
  // restampMarks can rebuild a chapter's diffs after a re-run (M7) — marks
  // are captured at createFileDiff time
  // `hunks` override: full-file mode passes the padded whole-file hunks
  const buildDiff = (holder, chapter, file, hunks) => {
    const slice = chapter.files.find((s) => s.file === file);
    if (!slice) return;
    const diff = createFileDiff(
      { path: slice.file, status: slice.status },
      hunks ?? slice.hunks,
      {
        annotations: annotationsFor(chapter, file),
      marks: chapter.attention.filter((m) => m.file === file),
        // gutter click → composer at that line (toggle on same line);
        // while a triage re-pin is pending, the click re-pins instead
        onLineNumberClick: ({ lineNumber, annotationSide }) => {
          const side = selectionSide({ annotationSide });
          if (pendingTriage && pendingTriage.file === file) {
            const comment = pendingTriage;
            pendingTriage = null;
            renderTriage();
            patchComment(comment, {
              reanchor: { chapterId: chapter.id, file, side, line: lineNumber },
            });
            return;
          }
          const same =
            composer.state?.chapterId === chapter.id &&
            composer.state.file === file &&
            composer.state.side === side &&
            composer.state.line === lineNumber;
          composer.state = same
            ? null
            : { chapterId: chapter.id, file, side, line: lineNumber };
          refreshAll();
        },
        // gutter drag across lines never fires a click — comment on the
        // selection's start line (v1 anchors a single line, design A)
        onSelectionEnd: (range) => {
          if (!range || range.end <= range.start) return; // click handled above
          composer.state = {
            chapterId: chapter.id,
            file,
            side: selectionSide(range),
            line: range.start,
          };
          refreshAll();
        },
        renderAnnotation: (annotation) => annotationRow(annotation, chapter, file),
        // hover + button in the gutter (U§3.2 copy-link); the callback gets
        // the line range — single click = one line
        onGutterUtilityClick: (range) =>
          copyLink(
            `#${current.id}/${chapter.id}/${encodeURIComponent(file)}/${range.start}`,
          ),
      },
    );
    if (diff) {
      diffs.set(`${chapter.id}\u0000${file}`, diff);
      holder.appendChild(diff.el);
    } else holder.innerHTML = `<div class="banner">binary file — no textual diff</div>`;
  };

  // full-file toggle (task 023, ux §3.2): swap the block between diff view
  // and the whole file padded by the adapter from /api/file content (no new
  // endpoint, no schema change). Deleted files have no head content — stay in
  // diff view. Also used by the holder mount loop below, so the mode survives
  // renderSession re-renders (viewed PATCH etc. re-fetch the padded content).
  const rebuildHolder = (chapter, file) => {
    const key = viewedKey(chapter.id, file);
    const holder = forceOpen(chapter.id, file); // full-file mode implies open
    const inst = diffs.get(key);
    if (inst) {
      inst.el.remove();
      diffs.delete(key);
    }
    if (!holder) return;
    const slice = chapter.files.find((s) => s.file === file);
    // only full-file mode fetches + pads; diff view mounts the stored hunks
    if (!isFullFile(chapter.id, file) || !slice || slice.status === "deleted")
      return buildDiff(holder, chapter, file);
    get(`/api/file?ref=${encodeURIComponent(current.head)}&path=${encodeURIComponent(file)}`)
      .then(({ content }) =>
        buildDiff(
          holder, chapter, file,
          fullFileHunks(slice.hunks, content.replace(/\n$/, "").split("\n")),
        ),
      )
      .catch(() => {
        fullFileMode.delete(key); // no content → back to plain diff view
        buildDiff(holder, chapter, file);
      });
  };
  const setFullFile = (chapter, file, on) => {
    const key = viewedKey(chapter.id, file);
    if (on) fullFileMode.add(key);
    else fullFileMode.delete(key);
    const head = [...document.querySelectorAll(".file-head")].find(
      (h) => h.dataset.chapter === chapter.id && h.dataset.file === file,
    );
    if (head) {
      const btn = head.querySelector(".file-full");
      if (btn) btn.textContent = on ? "diff view" : "full file";
      head.querySelector(".file-chevron").textContent = "▾";
    }
    rebuildHolder(chapter, file);
  };
  document.querySelectorAll(".file-full").forEach((btn) => {
    btn.onclick = () => {
      const chapter = current.chapters.find((c) => c.id === btn.dataset.chapter);
      if (chapter)
        setFullFile(chapter, btn.dataset.file, !isFullFile(chapter.id, btn.dataset.file));
    };
  });

  document.querySelectorAll(".diff-holder").forEach((holder) => {
    const chapter = current.chapters.find((c) => c.id === holder.dataset.chapter);
    const file = holder.dataset.file;
    if (!chapter) return;
    if (isFullFile(chapter.id, file)) rebuildHolder(chapter, file);
    else buildDiff(holder, chapter, file);
  });

  const restampMarks = (chapter) => {
    for (const s of chapter.files) {
      const key = `${chapter.id}\u0000${s.file}`;
      const inst = diffs.get(key);
      if (!inst) continue;
      const holder = inst.el.parentElement;
      inst.el.remove();
      diffs.delete(key);
      if (holder) buildDiff(holder, chapter, s.file);
    }
  };

  // narratives are generated eagerly by the server (§16.2) — the ↻ button
  // below is manual regeneration only. While a rerun runs, the chapter
  // shows a loading indicator and its edit button is hidden (§18).
  const narrating = new Set();
  const narrBox = (chapterId) =>
    document.querySelector(`.narrative-box[data-chapter="${chapterId}"]`);
  const setNarrating = (chapterId, on) => {
    const box = narrBox(chapterId);
    if (!box) return;
    box.classList.toggle("narrating", on);
    box.querySelector(".narrative-load").hidden = !on;
    const editBtn = box.closest(".chapter").querySelector(".narr-edit");
    if (editBtn) editBtn.hidden = on;
  };
  const setNarrView = (chapter) => {
    const box = narrBox(chapter.id);
    if (box) box.querySelector(".narrative-view").innerHTML = narrativeViewHtml(chapter);
  };
  const rerunChapterUi = async (chapterId, confirmed = false) => {
    const chapter = current.chapters.find((c) => c.id === chapterId);
    if (!chapter || narrating.has(chapterId)) return;
    narrating.add(chapterId);
    setNarrating(chapterId, true);
    try {
      current = await mut("POST", `/api/sessions/${encodeURIComponent(current.id)}/rerun`, {
        chapterId,
        confirm: confirmed || undefined,
      });
      const updated = current.chapters.find((c) => c.id === chapterId);
      if (updated) {
        setNarrating(chapterId, false);
        setNarrView(updated);
        restampMarks(updated);
      }
    } catch (e) {
      setNarrating(chapterId, false);
      if (e?.needsConfirm) {
        if (confirm("re-run overwrites your edited narrative — regenerate?"))
          await rerunChapterUi(chapterId, true);
      } else alert(e?.error ?? "could not generate narrative");
    } finally {
      narrating.delete(chapterId);
    }
  };
  document.querySelectorAll("button.rerun").forEach((btn) => {
    btn.onclick = () => {
      const chapter = current.chapters[Number(btn.dataset.i)];
      if (chapter) rerunChapterUi(chapter.id);
    };
  });

  // regenerate all (task 018, spec §16.6): one click re-runs rules marks,
  // classifier and narratives for every chapter; one confirm covers all
  // edited narratives (server 409s with needsConfirm otherwise). Feedback
  // while the sequential LLM loop runs: disabled button + progress banner,
  // plus the per-chapter "analyzing…" indicator (same pattern as rerun).
  document.getElementById("rerun-all")?.addEventListener("click", async () => {
    if (narrating.size) return; // a manual rerun is already in flight
    const edited = current.chapters.some((c) => c.narrativeEdited);
    if (edited && !confirm("regenerating overwrites your edited narratives — regenerate all?")) return;
    const btn = document.getElementById("rerun-all");
    btn.disabled = true;
    btn.textContent = "regenerating…";
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = `regenerating marks + narratives for ${current.chapters.length} chapters…`;
    document.querySelector("header")?.insertAdjacentElement("afterend", banner);
    for (const c of current.chapters) setNarrating(c.id, true);
    try {
      current = await mut("POST", `/api/sessions/${encodeURIComponent(current.id)}/rerun-all`, {
        confirm: edited || undefined,
      });
      renderSession(current);
    } catch (e) {
      banner.remove();
      btn.disabled = false;
      btn.textContent = "regenerate";
      for (const c of current.chapters) setNarrating(c.id, false);
      handleMutError(e);
    }
  });

  // re-chunk (spec §8a): re-run the chapter grouping on the stored diff;
  // server 409s with needsConfirm when any narrative is edited
  document.getElementById("rechunk")?.addEventListener("click", async () => {
    const edited = current.chapters.some((c) => c.narrativeEdited);
    if (edited && !confirm("re-grouping rebuilds the chapters (chapter ids may move, comments get re-anchored) — re-group?")) return;
    const btn = document.getElementById("rechunk");
    btn.disabled = true;
    btn.textContent = "re-grouping…";
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = "re-grouping chapters…";
    document.querySelector("header")?.insertAdjacentElement("afterend", banner);
    try {
      current = await mut("POST", `/api/sessions/${encodeURIComponent(current.id)}/rechunk`, {
        confirm: edited || undefined,
      });
      renderSession(current);
    } catch (e) {
      handleMutError(e);
    } finally {
      banner.remove();
      btn.disabled = false;
      btn.textContent = "re-group";
    }
  });

  // deep links (spec §17): scroll to + flash the target — renderSession
  // already resolved the owning chapter, so the target diff is mounted.
  // A target line outside every hunk (an unchanged-line comment, §13.3.5) is
  // only rendered in full-file mode — enter it first; scrollFlash's retry
  // loop covers the async fetch+mount. The instance is re-fetched per tick:
  // the full-file swap replaces the mounted diff.
  if (route?.target) {
    if (route.target === "line") {
      // diffs are keyed chapter\u0000file (multi-file chapters, task 009);
      // force the block open first — a viewed holder would be hidden
      forceOpen(route.chapterId, route.file);
      const chapter = current.chapters.find((c) => c.id === route.chapterId);
      if (
        chapter &&
        !isFullFile(route.chapterId, route.file) &&
        !lineInSlice(chapter, route.file, "new", route.line) &&
        !lineInSlice(chapter, route.file, "old", route.line)
      )
        setFullFile(chapter, route.file, true);
      const key = `${route.chapterId}\u0000${route.file}`;
      scrollFlash(() =>
        queryRow(diffs.get(key), "new", route.line) ?? queryRow(diffs.get(key), "old", route.line),
      );
    } else if (current.comments.some((c) => c.id === route.target)) {
      const comment = current.comments.find((c) => c.id === route.target);
      forceOpen(comment.chapterId, comment.file);
      const chapter = current.chapters.find((c) => c.id === comment.chapterId);
      if (
        chapter &&
        !isFullFile(comment.chapterId, comment.file) &&
        !lineInSlice(chapter, comment.file, comment.side, comment.line)
      )
        setFullFile(chapter, comment.file, true);
      const key = `${comment.chapterId}\u0000${comment.file}`;
      scrollFlash(() => queryComment(diffs.get(key), comment.id));
    } else {
      scrollFlash(() => document.querySelector(`.chapter[data-chapter="${route.target}"]`));
    }
  }

  // orphan triage (spec §13.4): re-pin by clicking a line in the file's new
  // diff — the pending click is captured in onLineNumberClick above
  const renderTriage = () => {
    const el = document.getElementById("triage");
    if (!el) return;
    const orphans = current.comments.filter((c) => c.orphaned && !c.resolved);
    if (orphans.length === 0) {
      el.remove();
      return;
    }
    el.innerHTML = pendingTriage
      ? `click a line in the <strong>${esc(pendingTriage.file)}</strong> diff to re-pin “${esc(pendingTriage.text)}” <button id="triage-cancel">cancel</button>`
      : `${orphans.length} comment${orphans.length === 1 ? "" : "s"} need re-pinning${orphans.map(triageItem).join("")}`;
    el.querySelectorAll(".triage-repin").forEach((b) => {
      b.onclick = () => {
        pendingTriage = current.comments.find((c) => c.id === b.dataset.comment);
        renderTriage();
        const chapter = current.chapters.find((c) =>
          c.files.some((s) => s.file === pendingTriage.file),
        );
        // one-chapter view: the file's chapter may not be mounted — switch
        // to it (the new render's renderTriage still shows the pending re-pin)
        if (chapter && chapter.id !== activeChapterId) {
          activeChapterId = chapter.id;
          renderSession(current);
          return;
        }
        forceOpen(chapter?.id, pendingTriage.file);
        scrollFlash(() => diffs.get(`${chapter?.id}\u0000${pendingTriage.file}`)?.el);
      };
    });
    el.querySelectorAll(".triage-resolve").forEach((b) => {
      b.onclick = () =>
        patchComment(
          current.comments.find((c) => c.id === b.dataset.comment),
          { resolved: true },
        );
    });
    const cancel = el.querySelector("#triage-cancel");
    if (cancel)
      cancel.onclick = () => {
        pendingTriage = null;
        renderTriage();
      };
  };
  renderTriage();

  // refresh (spec §13.2): in place for jj; git lands on a successor session
  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn)
    refreshBtn.onclick = async () => {
      try {
        const res = await mut("POST", `/api/sessions/${encodeURIComponent(current.id)}/refresh`, {});
        if (res.supersededBy) location.hash = `#${res.supersededBy}`;
        else renderSession(res.session);
      } catch (e) {
        alert(e?.error ?? "could not refresh");
      }
    };

  // chapter navigation (ux §3.3): prev/next in the chapter head, rail rows
  // switch chapters, file rows scroll to the mounted diff block, toggle
  // collapses the rail
  const goChapter = (delta) => {
    const i = current.chapters.findIndex((c) => c.id === activeChapterId);
    const next = current.chapters[i + delta];
    if (!next) return;
    activeChapterId = next.id;
    renderSession(current);
  };
  document.querySelectorAll(".chapter-prev").forEach((btn) => {
    btn.onclick = () => goChapter(-1);
  });
  document.querySelectorAll(".chapter-next").forEach((btn) => {
    btn.onclick = () => goChapter(1);
  });
  document.querySelectorAll(".rail-row").forEach((row) => {
    row.onclick = (ev) => {
      if (ev.target.closest(".rail-files")) return; // file click handles itself
      if (row.dataset.chapter !== activeChapterId) {
        activeChapterId = row.dataset.chapter;
        renderSession(current);
      }
    };
  });
  document.querySelectorAll(".rail-files li").forEach((li) => {
    li.onclick = () => {
      const cid = li.closest(".rail-row")?.dataset.chapter;
      forceOpen(cid, li.dataset.file); // explicit navigation reveals a viewed file
      scrollFlash(() =>
        [...document.querySelectorAll(".diff-holder")].find(
          (h) => h.dataset.chapter === cid && h.dataset.file === li.dataset.file,
        ),
      );
    };
  });
  document.getElementById("rail-toggle")?.addEventListener("click", () => {
    railCollapsed = !railCollapsed;
    document.querySelector(".rail")?.classList.toggle("collapsed", railCollapsed);
    const t = document.getElementById("rail-toggle");
    if (t) t.textContent = railCollapsed ? "▸" : "◂";
  });

  // archive / delete (task 017, spec §10): archive leaves the session list
  // (findable + restorable on the first screen); delete is permanent
  document.getElementById("archive")?.addEventListener("click", async () => {
    try {
      await mut("POST", `/api/sessions/${encodeURIComponent(current.id)}/archive`);
      location.hash = "";
    } catch (e) {
      alert(e?.error ?? "could not archive");
    }
  });
  document.getElementById("delete-review")?.addEventListener("click", async () => {
    if (!confirm("delete this review permanently?")) return;
    try {
      await mut("DELETE", `/api/sessions/${encodeURIComponent(current.id)}`);
      location.hash = "";
    } catch (e) {
      alert(e?.error ?? "could not delete");
    }
  });

  // narrative editing (§18): read view (rendered markdown) by default; the
  // edit button swaps in a textarea + save/cancel; save PATCHes the markdown
  // text verbatim (narrativeEdited → re-run asks, via rerunChapterUi)
  const enterEdit = (chapter) => {
    const box = narrBox(chapter?.id ?? "");
    if (!box) return;
    box.dataset.editing = "true";
    const ta = box.querySelector("textarea.narrative");
    ta.value = chapter.narrative === "unanalyzed" ? "" : chapter.narrative;
    box.querySelector(".narrative-view").hidden = true;
    ta.hidden = false;
    box.querySelector(".narrative-actions").hidden = false;
    ta.focus();
  };
  const exitEdit = (chapter) => {
    const box = narrBox(chapter?.id ?? "");
    if (!box) return;
    delete box.dataset.editing;
    box.querySelector(".narrative-view").hidden = false;
    box.querySelector("textarea.narrative").hidden = true;
    box.querySelector(".narrative-actions").hidden = true;
    const editBtn = box.closest(".chapter").querySelector(".narr-edit");
    if (editBtn) editBtn.hidden = box.classList.contains("narrating");
  };
  document.querySelectorAll("button.narr-edit").forEach((btn) => {
    btn.onclick = () => enterEdit(current.chapters[Number(btn.dataset.i)]);
  });
  document.querySelectorAll(".narrative-box").forEach((box) => {
    const chapterOf = () => current.chapters.find((c) => c.id === box.dataset.chapter);
    box.querySelector(".narr-cancel").onclick = () => exitEdit(chapterOf());
    box.querySelector(".narr-save").onclick = async () => {
      const ch = chapterOf();
      if (!ch) return;
      const text = box.querySelector("textarea.narrative").value;
      try {
        current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
          lastWriteAt: current.lastWriteAt,
          narrative: { chapterId: ch.id, text },
        });
        const updated = current.chapters.find((c) => c.id === ch.id);
        setNarrView(updated); // content may have gone placeholder → text
        exitEdit(updated);
      } catch (e) {
        if (e?.status === 409) {
          if (confirm("session changed elsewhere — reload?")) location.reload();
          return;
        }
        alert(e?.error ?? "could not save narrative");
      }
    };
  });

  // title editing (click the title or the ✎ affordance); the input starts
  // from the displayed title so editing the default feels natural
  const startTitleEdit = () => {
    const labelEl = document.getElementById("session-label");
    if (!labelEl) return; // already editing
    const input = document.createElement("input");
    input.value = current.label ?? displayTitle(current);
    labelEl.replaceWith(input);
    input.focus();
    const done = async () => {
      try {
        current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
          lastWriteAt: current.lastWriteAt,
          label: input.value,
        });
      } catch (e) {
        if (e?.status === 409 && confirm("session changed elsewhere — reload?")) location.reload();
      }
      renderSession(current);
    };
    input.onblur = done;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") input.blur();
      if (ev.key === "Escape") {
        input.onblur = null;
        renderSession(current);
      }
    };
  };
  document.getElementById("session-label")?.addEventListener("click", startTitleEdit);
  document.querySelector(".title-edit")?.addEventListener("click", startTitleEdit);

  // mark-reviewed button (task 022): toggles the reviewed state — no
  // checkbox anywhere in the header; re-render shows the marked state
  document.getElementById("mark-reviewed")?.addEventListener("click", async () => {
    try {
      current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
        lastWriteAt: current.lastWriteAt,
        reviewed: !current.reviewed,
      });
      renderSession(current);
    } catch (e) {
      if (e?.status === 409 && confirm("session changed elsewhere — reload?")) location.reload();
    }
  });

  // overflow menu closes once an action is picked (the actions navigate or
  // show their own banner — a lingering open menu hides the feedback)
  document.querySelector(".more-menu .menu")?.addEventListener("click", () => {
    const d = document.querySelector("details.more-menu");
    if (d) d.open = false;
  });
}
