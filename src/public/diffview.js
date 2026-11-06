// Two-column GitHub-style diff renderer (old left / new right).
// Escaping happens inside highlight.js; line numbers/text here are escaped too.
import { highlight, langFor } from "./highlight.js";

export function renderDiff(chapter, repoFile) {
  const lang = langFor(chapter.file);
  const table = document.createElement("table");
  table.className = "diff";

  for (const hunk of chapter.hunks) {
    const head = table.insertRow();
    head.className = "hunk-header";
    head.innerHTML = `<td colspan="4">${hunk.header ?? `@@ -${hunk.oldStart} +${hunk.newStart} @@`}</td>`;

    let oldState = {};
    let newState = {};
    const pendingDels = [];
    const emitPair = (del, add) => {
      const row = table.insertRow();
      row.className = "line";
      const numOld = del ? del.oldLine : "";
      const numNew = add ? add.newLine : "";
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
      row.dataset.oldLine = del ? del.oldLine : "";
      row.dataset.newLine = add ? add.newLine : "";
      row.innerHTML =
        `<td class="num num-old">${numOld}</td>` +
        `<td class="num num-new">${numNew}</td>` +
        `<td class="code ${del ? "del" : "ctx"}">${oldHtml}</td>` +
        `<td class="code ${add ? "add" : "ctx"}">${newHtml}</td>`;
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
  return table;
}
