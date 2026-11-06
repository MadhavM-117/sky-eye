// Read-only tree browser + file view (spec §11, U§2). Highlighted with the
// same highlighter as the diff.
import { get } from "./api.js";
import { esc, highlight, langFor } from "./highlight.js";

export function renderExplorer(app, session, route, backLink) {
  const sideRef = route.side === "base" ? session.base : session.head;
  const sideName = route.side === "base" ? "base" : "head";
  const dir = route.path || "";

  app.innerHTML = `
    <header>
      <a href="#" class="crumb-root">sky-eye</a>
      <span class="badge">${sideName}</span>
      <span class="crumbs" id="crumbs"></span>
      <span class="side-toggle">
        <button data-side="head" class="${sideName === "head" ? "on" : ""}">head</button>
        <button data-side="base" class="${sideName === "base" ? "on" : ""}">base</button>
      </span>
      <a class="explorer-link" href="#${esc(session.id)}">back to review</a>
    </header>
    <div id="explorer-body"><p class="empty">loading…</p></div>`;

  document.querySelectorAll(".side-toggle button").forEach((b) => {
    b.onclick = () => {
      location.hash = `#${session.id}/explorer/${route.path}§${b.dataset.side}`;
    };
  });

  // breadcrumb: repo name / segments
  const crumbs = document.getElementById("crumbs");
  const segments = dir ? dir.split("/") : [];
  const repoName = session.meta.repo.split("/").filter(Boolean).at(-1);
  crumbs.innerHTML =
    `<a href="${explorerHash(session, "", sideName)}">${esc(repoName)}</a>` +
    segments
      .map((seg, i) => {
        const prefix = segments.slice(0, i + 1).join("/");
        return ` / <a href="${explorerHash(session, prefix, sideName)}">${esc(seg)}</a>`;
      })
      .join("");

  const body = document.getElementById("explorer-body");

  if (looksLikeFile(dir)) {
    renderFileView(body, session, sideRef, dir, sideName, backLink);
    return;
  }

  get(`/api/tree?ref=${encodeURIComponent(sideRef)}&dir=${encodeURIComponent(dir)}`)
    .then((entries) => {
      const dirs = entries.filter((e) => e.type === "dir");
      const files = entries.filter((e) => e.type === "file");
      const li = (e, cls) =>
        `<li class="${cls}"><a href="${explorerHash(session, e.path, sideName)}">${esc(e.name)}</a></li>`;
      body.innerHTML =
        entries.length === 0
          ? `<p class="empty">empty directory</p>`
          : `<ul class="tree">${dirs.map((e) => li(e, "dir")).join("")}${files
              .map((e) => li(e, "file"))
              .join("")}</ul>`;
    })
    .catch((e) => {
      body.innerHTML = `<div class="banner error">${esc(e?.error ?? "could not load tree")}</div>`;
    });
}

function explorerHash(session, path, side) {
  return `#${session.id}/explorer/${encodeURIComponent(path)}§${side}`;
}

// a path is a file if it has an extension (dirs rarely do); final arbiter is
// the /api/tree vs /api/file response
function looksLikeFile(path) {
  const last = path.split("/").at(-1) ?? "";
  return last.includes(".");
}

async function renderFileView(body, session, ref, path, sideName, backLink) {
  try {
    const { content, binary } = await get(
      `/api/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    );
    if (binary) {
      body.innerHTML = `<div class="banner">binary file</div>`;
      return;
    }
    const lang = langFor(path);
    let state = {};
    const lines = content.split("\n").map((line) => {
      const r = highlight(line, lang, state);
      state = r.state;
      return `<span class="ln"></span><code>${r.html}\n</code>`;
    });
    body.innerHTML = `<div class="file-view"><div class="file-path">${esc(path)} <span class="meta">at ${sideName}</span></div><pre id="file-code"></pre></div>`;
    body.querySelector("#file-code").innerHTML = lines.join("");
  } catch (e) {
    body.innerHTML = `<div class="banner error">${esc(e?.error ?? "could not load file")}</div>`;
  }
}
