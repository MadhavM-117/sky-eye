// Zero-dependency line tokenizer (spec §19): JS/TS, Python, Rust, Go, JSON.
// Works line-by-line with multi-line comment/string state carried across
// contiguous lines, so it colors full files and isolated diff hunks alike.
// Returns escaped HTML — callers must not double-escape.

export function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KW = {
  js: "const let var function return if else for while class extends new import export from async await try catch finally throw switch case break continue typeof instanceof default delete in of yield static get set this super void null undefined true false void do with debugger",
  py: "def return if elif else for while class import from as with try except finally raise lambda pass break continue global nonlocal yield async await assert del in is not and or None True False self",
  rust: "fn let mut const struct enum impl trait pub use mod match if else for while loop return break continue self Self super crate where async await move ref dyn as in unsafe extern static type union macro_rules",
  go: "func package import var const type struct interface map chan go defer select switch case default if else for range return break continue fallthrough goto nil true false iota",
  json: "true false null",
};

const LANGS = {
  js: { kw: new Set(KW.js.split(" ")), line: "//", block: ["/*", "*/"], strs: ['"', "'", "`"] },
  py: { kw: new Set(KW.py.split(" ")), line: "#", block: null, strs: ['"""', "'''", '"', "'"] },
  rust: { kw: new Set(KW.rust.split(" ")), line: "//", block: ["/*", "*/"], strs: ['"'] },
  go: { kw: new Set(KW.go.split(" ")), line: "//", block: ["/*", "*/"], strs: ['"', "'", "`"] },
  json: { kw: new Set(KW.json.split(" ")), line: null, block: null, strs: ['"'] },
};

const EXT_LANG = {
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".ts": "js", ".tsx": "js",
  ".py": "py", ".rs": "rust", ".go": "go", ".json": "json",
};

export function langFor(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? null : EXT_LANG[path.slice(dot).toLowerCase()] ?? null;
}

const WORD = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(?:0[xXbBoO][\w]+|\d[\w.]*)/;

function findStringEnd(text, from, term) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text.startsWith(term, i)) return i + term.length;
  }
  return -1;
}

function span(cls, text) {
  return `<span class="tok-${cls}">${esc(text)}</span>`;
}

// highlight one line; state: { block?: string (closing term), str?: string (term) }
export function highlight(text, langName, state = {}) {
  const lang = LANGS[langName];
  if (!lang) return { html: esc(text), state };
  let html = "";
  let i = 0;

  // continue a multi-line comment or string from the previous line
  if (state.block) {
    const end = text.indexOf(state.block);
    if (end === -1) return { html: span("com", text), state };
    html += span("com", text.slice(0, end + state.block.length));
    i = end + state.block.length;
    state = {};
  } else if (state.str) {
    const end = findStringEnd(text, 0, state.str);
    if (end === -1) return { html: span("str", text), state };
    html += span("str", text.slice(0, end));
    i = end;
    state = {};
  }

  while (i < text.length) {
    const rest = text.slice(i);
    // line comment
    if (lang.line && rest.startsWith(lang.line)) {
      html += span("com", rest);
      break;
    }
    // block comment open
    if (lang.block && rest.startsWith(lang.block[0])) {
      const end = text.indexOf(lang.block[1], i + lang.block[0].length);
      if (end === -1) {
        html += span("com", rest);
        state = { block: lang.block[1] };
        break;
      }
      html += span("com", text.slice(i, end + lang.block[1].length));
      i = end + lang.block[1].length;
      continue;
    }
    // string open (longest term first: """ before ")
    const term = [...lang.strs]
      .sort((a, b) => b.length - a.length)
      .find((t) => rest.startsWith(t));
    if (term) {
      const end = findStringEnd(text, i + term.length, term);
      if (end === -1) {
        html += span("str", rest);
        state = { str: term };
        break;
      }
      html += span("str", text.slice(i, end));
      i = end;
      continue;
    }
    // word
    const wm = rest.match(WORD);
    if (wm) {
      const word = wm[0];
      const after = text.slice(i + word.length);
      if (lang.kw.has(word)) html += span("kw", word);
      else if (/^[A-Z]/.test(word)) html += span("type", word);
      else if (/^\s*\(/.test(after)) html += span("fn", word);
      else html += esc(word);
      i += word.length;
      continue;
    }
    const nm = rest.match(NUMBER);
    if (nm) {
      html += span("num", nm[0]);
      i += nm[0].length;
      continue;
    }
    if (/\s/.test(text[i])) {
      html += text[i];
      i++;
      continue;
    }
    html += esc(text[i]);
    i++;
  }
  return { html, state };
}
