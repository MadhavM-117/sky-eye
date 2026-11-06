// Hash router + first screen + session view (spec §18, U§1.5, U§3).
import { get, mut } from "./api.js";
import { renderDiff } from "./diffview.js";
import { renderExplorer } from "./explorer.js";

const app = document.getElementById("app");

// hash forms: "" | "#<sid>" | "#<sid>/explorer/<encPath>§<side>"
// (paths are percent-encoded, so no raw slashes inside the encoded part)
function parseHash() {
  const h = location.hash.slice(1);
  const idx = h.indexOf("/explorer/");
  if (idx > 0) {
    const sid = h.slice(0, idx);
    const rest = h.slice(idx + "/explorer/".length);
    const sep = rest.indexOf("§");
    const encPath = sep === -1 ? rest : rest.slice(0, sep);
    const side = sep === -1 || !rest.slice(sep + 1) ? "head" : rest.slice(sep + 1);
    return { view: "explorer", sid, path: decodeURIComponent(encPath), side };
  }
  return h ? { view: "session", sid: h } : { view: "first" };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

window.addEventListener("hashchange", render);
render();

async function render() {
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
    renderSession(session);
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

function renderSession(session) {
  shell(session.label ?? session.id, "");
  const headLabel = session.headRef ?? short(session.head);
  const baseLabel = session.baseRef ?? short(session.base);

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
      <label class="reviewed-toggle"><input type="checkbox" id="reviewed" ${session.reviewed ? "checked" : ""}/> reviewed</label>
      <a class="explorer-link" href="#${esc(session.id)}/explorer//head">files</a>
    </header>
    <div class="chapters">${chaptersHtml}</div>`);

  wireSession(session);
}

const badge = (session) =>
  session.meta.repo.split("/").slice(-1)[0] + " review";

function chapterHtml(session, c, index) {
  const encFile = encodeURIComponent(c.file);
  return `
  <section class="chapter" data-chapter="${c.id}">
    <h2 class="chapter-head">
      <button class="collapse" data-i="${index}">▾</button>
      <a class="file-link" href="#${esc(session.id)}/explorer/${encFile}/head">${esc(c.file)}</a>
      <span class="status ${c.status}">${c.status}</span>
    </h2>
    <div class="chapter-body">
      <textarea class="narrative" data-chapter="${c.id}" rows="2"
        placeholder="what's happening in this chapter…">${esc(c.narrative)}</textarea>
      <div class="diff-holder" data-chapter="${c.id}"></div>
    </div>
  </section>`;
}

function wireSession(session) {
  let current = session;

  document.querySelectorAll(".diff-holder").forEach((holder) => {
    const chapter = current.chapters.find((c) => c.id === holder.dataset.chapter);
    holder.appendChild(renderDiff(chapter));
  });

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
