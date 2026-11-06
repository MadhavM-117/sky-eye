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
  const [refs, sessions] = await Promise.all([get("/api/refs"), get("/api/sessions")]);

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
      <h2>Sessions</h2>
      ${sessions.length === 0 ? `<p class="empty">no sessions yet</p>` : `<ul class="session-list">${sessions.map((s) => `
        <li><a href="#${esc(s.id)}">
          <span class="label">${esc(s.label ?? s.id)}</span>
          ${s.aliases.length ? `<span class="aliases">${esc(s.aliases.join(" "))}</span>` : ""}
          ${s.reviewed ? `<span class="chip reviewed">reviewed</span>` : ""}
          <span class="meta">${s.openComments} open · ${new Date(s.updatedAt).toLocaleString()}</span>
        </a></li>`).join("")}</ul>`}
    </section>`);

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
    </header>
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

function chapterHtml(session, c, index) {
  const encFile = encodeURIComponent(c.file);
  const [add, del] = c.hunks.reduce(
    ([a, d], h) => [
      a + h.lines.filter((l) => l.type === "add").length,
      d + h.lines.filter((l) => l.type === "del").length,
    ],
    [0, 0],
  );
  return `
  <section class="chapter" data-chapter="${c.id}">
    <h2 class="chapter-head">
      <button class="collapse" data-i="${index}">▾</button>
      <a class="file-link" href="#${esc(session.id)}/explorer/${encFile}/head">${esc(c.file)}</a>
      <span class="status ${c.status}">${c.status}</span>
      <span class="stats">${del || !add ? `<span class="del">−${del}</span> ` : ``}<span class="add">+${add}</span></span>
    </h2>
    <div class="chapter-body">
      <textarea class="narrative" data-chapter="${c.id}" rows="2"
        placeholder="what's happening in this chapter…">${esc(c.narrative)}</textarea>
      <div class="diff-holder" data-chapter="${c.id}"></div>
    </div>
  </section>`;
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
    return current;
  };
  const refreshAll = () => {
    for (const [chapterId, inst] of diffs) {
      const chapter = current.chapters.find((c) => c.id === chapterId);
      if (chapter) updateAnnotations(inst, annotationsFor(chapter));
    }
  };
  const annotationsFor = (chapter) =>
    commentAnnotations(
      current.comments.filter((c) => c.chapterId === chapter.id),
      composer.state?.chapterId === chapter.id ? composer.state : null,
    );

  const postComment = async (chapter, text, priority) => {
    if (!text.trim()) return;
    const state = composer.state;
    composer.state = null;
    try {
      await mut("POST", "/api/comments", {
        sessionId: current.id,
        chapterId: chapter.id,
        file: chapter.file,
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
  const annotationRow = (annotation, chapter) => {
    const row = document.createElement("div");
    row.className = "sky-comment-row";
    for (const entry of annotation.metadata.comments) {
      if (entry.composer) {
        row.append(
          composerNode(composer.state, {
            onSubmit: (text, priority) => postComment(chapter, text, priority),
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

  document.querySelectorAll(".diff-holder").forEach((holder) => {
    const chapter = current.chapters.find((c) => c.id === holder.dataset.chapter);
    const diff = createFileDiff(
      { path: chapter.file, status: chapter.status },
      chapter.hunks,
      {
        annotations: annotationsFor(chapter),
        // gutter click → composer at that line (toggle on same line)
        onLineNumberClick: ({ lineNumber, annotationSide }) => {
          const side = selectionSide({ annotationSide });
          const same =
            composer.state?.chapterId === chapter.id &&
            composer.state.side === side &&
            composer.state.line === lineNumber;
          composer.state = same ? null : { chapterId: chapter.id, side, line: lineNumber };
          refreshAll();
        },
        renderAnnotation: (annotation) => annotationRow(annotation, chapter),
        // hover + button in the gutter (U§3.2 copy-link); the callback gets
        // the line range — single click = one line
        onGutterUtilityClick: (range) =>
          copyLink(
            `#${current.id}/${chapter.id}/${encodeURIComponent(chapter.file)}/${range.start}`,
          ),
      },
    );
    if (diff) {
      diffs.set(chapter.id, diff);
      holder.appendChild(diff.el);
    } else holder.innerHTML = `<div class="banner">binary file — no textual diff</div>`;
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
      const chapter = current.chapters.find((c) => c.id === route.chapterId);
      if (chapter)
        tryScroll(() =>
          queryRow(diffs.get(chapter.id), "new", route.line) ??
          queryRow(diffs.get(chapter.id), "old", route.line),
        );
    } else if (current.comments.some((c) => c.id === route.target)) {
      const comment = current.comments.find((c) => c.id === route.target);
      tryScroll(() => queryComment(diffs.get(comment.chapterId), comment.id));
    } else {
      const chapter = current.chapters.find((c) => c.id === route.target);
      diffs.get(chapter?.id)?.el.scrollIntoView({ block: "start" });
    }
  }

  document.querySelectorAll(".collapse").forEach((btn) => {
    btn.onclick = () => btn.closest(".chapter").classList.toggle("collapsed");
  });

  document.querySelectorAll("textarea.narrative").forEach((ta) => {
    ta.onchange = async () => {
      try {
        current = await mut("PATCH", `/api/sessions/${encodeURIComponent(current.id)}`, {
          lastWriteAt: current.lastWriteAt,
          narrative: { chapterId: ta.dataset.chapter, text: ta.value },
        });
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
