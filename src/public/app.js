// Hash router + first screen + session view (spec §18, U§1.5, U§3).
// Comments (M2, design A): inline annotation rows under the clicked line,
// rendered through pierre's annotation framework via the adapter.
import { get, mut } from "./api.js";
import {
  commentAnnotations,
  createFileDiff,
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

function renderSession(session, route = null) {
  shell(session.label ?? session.id, "");
  const headLabel = session.headRef ?? short(session.head);
  const baseLabel = session.baseRef ?? short(session.base);
  const openCount = session.comments.filter((c) => !c.resolved).length;

  const chaptersHtml =
    session.chapters.length === 0
      ? `<p class="empty">nothing to review for this comparison</p>`
      : session.chapters
          .map((c, i) => chapterHtml(session, c, i))
          .join("");

  shell(session.label ?? session.id, `
    <header>
      <a href="#">sky-eye</a>
      <span class="badge">${badge(session)}</span>
      <span class="session-title" id="session-label" title="click to rename">${esc(session.label ?? session.id)}</span>
      <span class="aliases">${esc(session.aliases.join(" "))}</span>
      <span class="meta">${baseLabel} → ${headLabel}</span>
      <span class="meta" id="open-count">${openCount} open comments</span>
      <label class="reviewed-toggle"><input type="checkbox" id="reviewed" ${session.reviewed ? "checked" : ""}/> reviewed</label>
      <a class="explorer-link" href="#${esc(session.id)}/explorer//head">files</a>
      <!-- export (§14): a plain link — the route's Content-Disposition triggers the download -->
      <a class="explorer-link" href="/api/sessions/${encodeURIComponent(session.id)}/export">export</a>
      <button id="rerun-all" title="re-generate marks + narratives for every chapter">regenerate</button>
      <button id="archive" title="move out of the session list (restorable from the first screen)">archive</button>
      <button id="delete-review" title="delete permanently">delete</button>
    </header>
    ${bannersHtml(session)}
    <div class="chapters">${chaptersHtml}</div>`);

  wireSession(session, route);
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
  const [add, del] = c.files.reduce(
    ([a, d], s) => [
      a + s.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "add").length, 0),
      d + s.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "del").length, 0),
    ],
    [0, 0],
  );
  // a chapter may span files (spec §9.3): one diff block per file slice
  const blocks = c.files
    .map(
      (s) => `
      <h3 class="file-head">
        <a class="file-link" href="#${esc(session.id)}/explorer/${encodeURIComponent(s.file)}/head">${esc(s.file)}</a>
        <span class="status ${s.status}">${s.status}</span>
      </h3>
      <div class="diff-holder" data-chapter="${c.id}" data-file="${esc(s.file)}"></div>`,
    )
    .join("");
  return `
  <section class="chapter" data-chapter="${c.id}">
    <h2 class="chapter-head">
      <button class="collapse" data-i="${index}">▾</button>
      <span class="chapter-title">chapter ${index + 1}</span>
      <span class="stats">${del || !add ? `<span class="del">−${del}</span> ` : ``}<span class="add">+${add}</span></span>
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
  // pending orphan-triage re-pin (spec §13.4): next gutter click on that
  // file's diff re-pins instead of opening the composer
  let triage = null;
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
  // annotations are per file slice inside a chapter (task 009); attention
  // marks (M5) do not ride this projection — the adapter stamps them into
  // the gutter via onPostRender (task 009), fed per file slice below
  const annotationsFor = (chapter, file) =>
    commentAnnotations(
      current.comments.filter((c) => c.chapterId === chapter.id && c.file === file),
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
  const buildDiff = (holder, chapter, file) => {
    const slice = chapter.files.find((s) => s.file === file);
    if (!slice) return;
    const diff = createFileDiff(
      { path: slice.file, status: slice.status },
      slice.hunks,
      {
        annotations: annotationsFor(chapter, file),
      marks: chapter.attention.filter((m) => m.file === file),
        // gutter click → composer at that line (toggle on same line);
        // while a triage re-pin is pending, the click re-pins instead
        onLineNumberClick: ({ lineNumber, annotationSide }) => {
          const side = selectionSide({ annotationSide });
          if (triage && triage.file === file) {
            const comment = triage;
            triage = null;
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

  document.querySelectorAll(".diff-holder").forEach((holder) => {
    const chapter = current.chapters.find((c) => c.id === holder.dataset.chapter);
    const file = holder.dataset.file;
    if (chapter) buildDiff(holder, chapter, file);
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

  // M7 (§16.2): lazy narrative generation — the server generates on first
  // request, so fire one rerun per still-unanalyzed chapter on session open
  // (chapters render expanded, so "first expansion" is here). Sequential:
  // each response refreshes `current`, keeping lastWriteAt fresh for any
  // concurrent narrative edit PATCH. 409 needsConfirm (edited narrative)
  // asks before overwriting (§10). While a rerun runs, the chapter shows a
  // loading indicator and its edit button is hidden (§18).
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
  for (const c of current.chapters.filter((c) => c.narrative === "unanalyzed"))
    if (narrBox(c.id)?.dataset.editing !== "true") rerunChapterUi(c.id);
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
    if (narrating.size) return; // lazy first-run narration already in flight
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

  // deep links (spec §17): scroll to + flash the target; retry because lazy
  // grammar loading can re-render rows after the first pass
  if (route?.target) {
    const tryScroll = (find) => {
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
    };
    if (route.target === "line") {
      // diffs are keyed chapter\u0000file (multi-file chapters, task 009)
      const inst = diffs.get(`${route.chapterId}\u0000${route.file}`);
      if (inst)
        tryScroll(() =>
          queryRow(inst, "new", route.line) ?? queryRow(inst, "old", route.line),
        );
    } else if (current.comments.some((c) => c.id === route.target)) {
      const comment = current.comments.find((c) => c.id === route.target);
      tryScroll(() =>
        queryComment(diffs.get(`${comment.chapterId}\u0000${comment.file}`), comment.id),
      );
    } else {
      const chapter = current.chapters.find((c) => c.id === route.target);
      diffs.get(chapter?.id)?.el.scrollIntoView({ block: "start" });
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
    el.innerHTML = triage
      ? `click a line in the <strong>${esc(triage.file)}</strong> diff to re-pin “${esc(triage.text)}” <button id="triage-cancel">cancel</button>`
      : `${orphans.length} comment${orphans.length === 1 ? "" : "s"} need re-pinning${orphans.map(triageItem).join("")}`;
    el.querySelectorAll(".triage-repin").forEach((b) => {
      b.onclick = () => {
        triage = current.comments.find((c) => c.id === b.dataset.comment);
        renderTriage();
        const chapter = current.chapters.find((c) =>
          c.files.some((s) => s.file === triage.file),
        );
        diffs.get(`${chapter?.id}\u0000${triage.file}`)?.el.scrollIntoView({ block: "center" });
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
        triage = null;
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

  document.querySelectorAll(".collapse").forEach((btn) => {
    btn.onclick = () => btn.closest(".chapter").classList.toggle("collapsed");
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

  const labelEl = document.getElementById("session-label");
  labelEl.onclick = () => {
    const input = document.createElement("input");
    input.value = current.label ?? "";
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

  document.getElementById("reviewed").onchange = async (ev) => {
    try {
      current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
        lastWriteAt: current.lastWriteAt,
        reviewed: ev.target.checked,
      });
    } catch (e) {
      if (e?.status === 409 && confirm("session changed elsewhere — reload?")) location.reload();
    }
  };
}
