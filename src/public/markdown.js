// Minimal markdown → HTML for chapter narratives (spec §18). Escape-first:
// every line is HTML-escaped before any markdown transform runs, so model
// or user text can never inject markup — the transforms only ever add the
// tags below. Pure module (no DOM) so node tests can import it directly.
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// inline spans: code before emphasis (so `*` inside code stays literal);
// links only with http(s) hrefs — no relative/javascript URLs
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>',
    );
}

export function mdToHtml(md) {
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  let fence = null; // array of code lines when inside ```
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
  };
  const flushFence = () => {
    if (fence) {
      out.push(`<pre><code>${fence.join("\n")}</code></pre>`);
      fence = null;
    }
  };

  // escape at intake: fences bypass inline(), so per-line escaping here
  // covers every path — nothing raw ever reaches the output
  for (const line of md.split("\n")) {
    const raw = esc(line);
    if (raw.trim().startsWith("```")) {
      if (fence) flushFence();
      else {
        flushPara();
        flushList();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (!raw.trim()) {
      flushPara();
      flushList();
      continue;
    }
    para.push(raw.trim());
  }
  flushPara();
  flushList();
  flushFence();
  return out.join("\n");
}
