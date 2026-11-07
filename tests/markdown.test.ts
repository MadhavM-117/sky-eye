// mdToHtml fixtures (spec §18): escape-first markdown rendering — the
// security property (no HTML injection) is the point of most of these.
import test from "node:test";
import assert from "node:assert/strict";
import { mdToHtml } from "../src/public/markdown.js";

test("escapes HTML before markdown runs — no injection from model/user text", () => {
  const html = mdToHtml('<script>alert(1)</script> & "quotes" <img src=x>');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("inline: code, bold, italic, links", () => {
  assert.equal(mdToHtml("a `code` span"), "<p>a <code>code</code> span</p>");
  assert.equal(mdToHtml("**bold** and *ital*"), "<p><strong>bold</strong> and <em>ital</em></p>");
  const link = mdToHtml("see [docs](https://example.com/x)");
  assert.match(link, /<a href="https:\/\/example.com\/x"/);
  // javascript:/relative URLs are never linked
  assert.doesNotMatch(mdToHtml("[x](javascript:alert(1))"), /<a /);
});

test("blocks: paragraphs, headings, lists, fenced code", () => {
  const md = [
    "first paragraph,",
    "wrapped onto two lines.",
    "",
    "## heading",
    "",
    "- item one",
    "- item two",
    "",
    "1. step",
    "2. step",
    "",
    "```",
    "const x = <b>raw</b>;",
    "```",
  ].join("\n");
  const html = mdToHtml(md);
  assert.match(html, /<p>first paragraph, wrapped onto two lines\.<\/p>/);
  assert.match(html, /<h2>heading<\/h2>/);
  assert.match(html, /<ul><li>item one<\/li><li>item two<\/li><\/ul>/);
  assert.match(html, /<ol><li>step<\/li><li>step<\/li><\/ol>/);
  assert.match(html, /<pre><code>const x = &lt;b&gt;raw&lt;\/b&gt;;<\/code><\/pre>/);
});

test("markdown markers inside code spans stay literal; plain text passes through", () => {
  assert.equal(mdToHtml("use `a ** b` here"), "<p>use <code>a ** b</code> here</p>");
  assert.equal(mdToHtml("just a sentence"), "<p>just a sentence</p>");
  assert.equal(mdToHtml(""), "");
});
