// Two-column diff in pierre-style grid rows (old num/code | new num/code).
// Escaping happens inside highlight.js; line numbers here are escaped too.
import { esc, highlight, langFor } from "./highlight.js";

export function renderDiff(chapter, repoFile) {
  const lang = langFor(chapter.file);
  const root = document.createElement("div");
  root.className = "diff";

  for (const hunk of chapter.hunks) {
    const sep = document.createElement("div");
    sep.className = "hunk-sep";
    sep.innerHTML = `<span>${esc(hunk.header ?? `@@ -${hunk.oldStart} +${hunk.newStart} @@`)}</span>`;
    root.appendChild(sep);

    let oldState = {};
    let newState = {};
    const pendingDels = [];
    const emitPair = (del, add) => {
      let oldHtml = "";
      let newHtml = "";
      if (del) {
        const r = highlight(del.text, lang, oldState);
        oldHtml = r.html;
        oldState = r.state;
      }
      if (add) {
        const r = highlight(add.text, lang, newState);
        newHtml = r.html;
        newState = r.state;
      }
      const row = document.createElement("div");
      row.className = "line";
      row.dataset.lineType = del && add ? "context" : add ? "change-addition" : "change-deletion";
      row.dataset.oldLine = del ? del.oldLine : "";
      row.dataset.newLine = add ? add.newLine : "";
      row.innerHTML =
        `<span class="num num-old">${del ? del.oldLine : ""}</span>` +
        `<span class="code ${del ? "del" : ""}">${oldHtml || "&nbsp;"}</span>` +
        `<span class="num num-new">${add ? add.newLine : ""}</span>` +
        `<span class="code ${add ? "add" : ""}">${newHtml || "&nbsp;"}</span>`;
      root.appendChild(row);
    };
    const flushDels = (adds) => {
      const n = Math.max(pendingDels.length, adds.length);
      for (let i = 0; i < n; i++) emitPair(pendingDels[i] ?? null, adds[i] ?? null);
      pendingDels.length = 0;
    };

    for (const line of hunk.lines) {
      if (line.type === "ctx") {
        flushDels([]);
        emitPair(line, line);
        // context text is identical; resync both sides' tokenizer state
        oldState = newState;
      } else if (line.type === "del") {
        pendingDels.push(line);
      } else {
        flushDels([line]);
      }
    }
    flushDels([]);
  }
  return root;
}
