// Read-only explorer (spec §11, U§2, spec §18.3): sky-eye breadcrumb chrome +
// side toggle around @pierre/trees FileTree (search, git-status badges), file
// contents rendered by @pierre/diffs File. Changed files in chapters link here.
import { get } from "./api.js";
import { createFileTree, createFileView } from "./pierre-adapter.js";

export async function renderExplorer(app, session, route, backLink) {
  const sideRef = route.side === "base" ? session.base : session.head;
  const sideName = route.side === "base" ? "base" : "head";

  app.innerHTML = `
    <header>
      <a href="#" class="crumb-root">sky-eye</a>
      <span class="badge">${sideName}</span>
      <span class="crumbs" id="crumbs">${esc(route.path)}</span>
      <span class="side-toggle">
        <button data-side="head" class="${sideName === "head" ? "on" : ""}">head</button>
        <button data-side="base" class="${sideName === "base" ? "on" : ""}">base</button>
      </span>
      <a class="explorer-link" href="#${esc(session.id)}">back to review</a>
    </header>
    <div class="explorer">
      <div class="explorer-tree" id="explorer-tree"><p class="empty">loading…</p></div>
      <div class="explorer-file" id="explorer-file"></div>
    </div>`;

  document.querySelectorAll(".side-toggle button").forEach((b) => {
    b.onclick = () => {
      location.hash = `#${session.id}/explorer/${encodeURIComponent(route.path)}§${b.dataset.side}`;
    };
  });

  const treeHost = document.getElementById("explorer-tree");
  const fileHost = document.getElementById("explorer-file");

  try {
    const entries = await get(
      `/api/tree?ref=${encodeURIComponent(sideRef)}&recursive=1`,
    );
    let tree;
    try {
      tree = createFileTree({
        paths: entries.map((e) => e.path),
        changed: session.chapters,
        onOpen: (path) => {
          location.hash = `#${session.id}/explorer/${encodeURIComponent(path)}§${route.side}`;
        },
      });
      treeHost.replaceChildren(tree.el);
      if (route.path) tree.tree.scrollToPath(route.path, { focus: false });
    } catch (e) {
      treeHost.innerHTML = `<div class="banner error">${esc(e?.message ?? "tree failed to load")}</div>`;
    }

    if (route.path) await renderFilePane(fileHost, session, sideRef, route.path, sideName);
    else fileHost.innerHTML = `<p class="empty">pick a file from the tree</p>`;
  } catch (e) {
    fileHost.innerHTML = `<div class="banner error">${esc(e?.error ?? "could not load tree")}</div>`;
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderFilePane(host, session, ref, path, sideName) {
  try {
    const { content, binary } = await get(
      `/api/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    );
    if (binary) {
      host.innerHTML = `<div class="banner">binary file</div>`;
      return;
    }
    host.replaceChildren(createFileView(path, content).el);
  } catch (e) {
    host.innerHTML = `<div class="banner error">${esc(e?.error ?? "could not load file")}</div>`;
  }
}
