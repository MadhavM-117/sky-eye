// Comment + composer DOM for annotation rows (M2, design A: inline rows
// below the line). Rendered inside pierre's shadow root — styling comes from
// the stylesheet the adapter injects there, app-chrome vars still resolve.
// Pure builders: no fetches, no app state — app.js passes handlers.

export function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const button = (label, title, onclick) => {
  const b = el("button", null, label);
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    onclick(b);
  };
  return b;
};

// One stored comment. Open: full row with resolve/edit/link actions.
// Resolved: one-line summary, click to expand (reopen inside).
export function commentNode(comment, handlers) {
  const node = el("div", "sky-comment");
  node.dataset.commentId = comment.id;
  if (comment.resolved) node.classList.add("resolved");

  const author = comment.author?.name ?? "anonymous";
  const chip = comment.priority
    ? el("span", "sky-chip", comment.priority)
    : null;
  const actions = el("span", "sky-comment-actions");

  const full = () => {
    node.replaceChildren();
    const head = el("div", "sky-comment-head");
    head.append(el("span", "author", author), el("span", null, timeAgo(comment.createdAt)));
    if (chip) head.append(chip);
    if (comment.resolved) head.append(el("span", null, "resolved"));
    actions.replaceChildren(
      button(comment.resolved ? "reopen" : "resolve", null, () => handlers.onResolve(comment, !comment.resolved)),
      button("edit", "edit comment", () => edit()),
      button("link", "copy deep link", () => handlers.onCopy(comment)),
    );
    head.append(actions);
    node.append(head, el("div", "sky-comment-text", comment.text));
  };

  const collapsed = () => {
    node.replaceChildren(
      el(
        "div",
        "sky-comment-head",
        `✓ resolved by ${author}: ${comment.text.split("\n")[0]}`,
      ),
    );
    node.style.cursor = "pointer";
    node.onclick = () => {
      node.style.cursor = "";
      node.onclick = null;
      full();
    };
  };

  const edit = () => {
    node.replaceChildren();
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = comment.text;
    const save = () => handlers.onEdit(comment, ta.value);
    const bar = el("div", "sky-composer-actions");
    bar.append(
      button("save", null, save),
      button("cancel", null, () => (comment.resolved ? collapsed() : full())),
    );
    node.append(ta, bar);
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
      if (e.key === "Escape") {
        e.stopPropagation();
        comment.resolved ? collapsed() : full();
      }
    };
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };

  if (comment.resolved) collapsed();
  else full();
  return node;
}

// Inline composer for a (chapter, side, line) target. Ctrl/Cmd+Enter submits,
// Escape cancels. `priority` is "" (normal) / "nit" / "must-fix".
export function composerNode(state, handlers) {
  const node = el("div", "sky-composer");
  const ta = document.createElement("textarea");
  ta.rows = 3;
  ta.placeholder = "leave a comment…";
  if (state.text) ta.value = state.text;
  const select = document.createElement("select");
  for (const [value, label] of [
    ["", "priority: normal"],
    ["nit", "priority: nit"],
    ["must-fix", "priority: must-fix"],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  }
  if (state.priority) select.value = state.priority;
  const submit = () => handlers.onSubmit(ta.value, select.value);
  const cancel = () => handlers.onCancel();
  const bar = el("div", "sky-composer-actions");
  bar.append(
    el("span", null, `${state.side}:${state.line}`),
    select,
    button("cancel", null, cancel),
  );
  const submitBtn = button("comment", null, submit);
  submitBtn.classList.add("submit");
  bar.append(submitBtn);
  node.append(ta, bar);
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  };
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  return node;
}
