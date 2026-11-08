// Chapter-ordering validation (spec §16.7) — pure fixtures over
// parseOrderResponse; no adapters, no fs.
import test from "node:test";
import assert from "node:assert/strict";
import { orderSystemPrompt, parseOrderResponse } from "../src/narrate.ts";
import type { Chapter } from "../src/types.ts";

const chapter = (id: string): Chapter => ({
  id,
  files: [],
  narrative: "unanalyzed",
  attention: [],
});

const chapters = [chapter("a"), chapter("b"), chapter("c")];

test("parseOrderResponse: valid permutation reorders", () => {
  assert.deepEqual(
    parseOrderResponse(JSON.stringify({ order: ["c", "a", "b"] }), chapters),
    ["c", "a", "b"],
  );
});

test("parseOrderResponse: unknown ids dropped, duplicates first-wins", () => {
  assert.deepEqual(
    parseOrderResponse(JSON.stringify({ order: ["zz", "b", "b", "c"] }), chapters),
    ["b", "c", "a"],
  );
});

test("parseOrderResponse: missed chapters keep path order, appended at the end", () => {
  assert.deepEqual(
    parseOrderResponse(JSON.stringify({ order: ["c"] }), chapters),
    ["c", "a", "b"],
  );
});

test("parseOrderResponse: malformed / wrong shape → path order", () => {
  for (const raw of [
    "not json",
    JSON.stringify({ order: "a,b,c" }),
    JSON.stringify({ order: [1, 2, 3] }),
    JSON.stringify({}),
    JSON.stringify([]),
  ])
    assert.deepEqual(parseOrderResponse(raw, chapters), ["a", "b", "c"], raw);
});

test("parseOrderResponse: single chapter / empty list are no-ops", () => {
  assert.deepEqual(parseOrderResponse('{"order": ["x"]}', [chapter("only")]), ["only"]);
  assert.deepEqual(parseOrderResponse('{"order": []}', []), []);
});

test("orderSystemPrompt demands the JSON permutation shape", () => {
  assert.match(orderSystemPrompt(), /JSON/);
  assert.match(orderSystemPrompt(), /every id exactly once/);
});
