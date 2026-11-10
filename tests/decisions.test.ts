import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CRITERIA,
  DecisionsError,
  decisionsClassify,
  decisionsRequestBody,
  parseDecisionsResponse,
  resolveApiKey,
} from "../src/decisions.ts";
import { applyClassifier, classifierRequest, loadClassifierConfig } from "../src/custom-classifier.ts";
import type { Chapter, ClassifierConfig, Hunk } from "../src/types.ts";

// isolate from the shell: a real OPENROUTER_API_KEY / OPENAI_API_KEY flips
// key-resolution precedence and makes the "no key" path hit the network
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

const withConfig = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dec-"));
  fs.mkdirSync(path.join(dir, ".sky-eye"), { recursive: true });
  if (body !== null)
    fs.writeFileSync(path.join(dir, ".sky-eye", "config.json"), JSON.stringify(body));
  return dir;
};

const hunk: Hunk = {
  oldStart: 1,
  newStart: 1,
  oldLines: 2,
  newLines: 2,
  lines: [
    { type: "del", oldLine: 1, text: "old line" },
    { type: "add", newLine: 2, text: "await checkPassword(pwd)" },
  ],
};
const chapter: Chapter = {
  id: "c1",
  files: [{ file: "src/auth.ts", status: "modified", hunks: [hunk] }],
  narrative: "",
  attention: [],
};
const request = (chapters: Chapter[] = [chapter]) => classifierRequest("/repo", "b1", "h1", chapters);
const decisionsCfg = (extra: object = {}): ClassifierConfig => ({ builtin: "openrouter", model: "typesafe/jev-1.14", ...extra });

// ---- config ----------------------------------------------------------------

test("loadClassifierConfig: command wins over builtin; the OpenRouter backend needs a model", () => {
  assert.equal(loadClassifierConfig(withConfig({ classifier: { command: "x", builtin: "openrouter", model: "m" } }))?.command, "x");
  assert.equal(loadClassifierConfig(withConfig({ classifier: { builtin: "openrouter" } })), undefined);
  assert.equal(loadClassifierConfig(withConfig({ classifier: { builtin: "other", model: "m" } })), undefined);
});

test("loadClassifierConfig: openai backend defaults the model to gpt-6-luna", () => {
  const cfg = loadClassifierConfig(withConfig({ classifier: { builtin: "openai", model: "  " } }))!;
  assert.equal(cfg.builtin, "openai");
  assert.equal(cfg.model, "gpt-6-luna");
  assert.equal(cfg.fallback, true);
});

test("loadClassifierConfig: decision backend fills defaults, criteria validated", () => {
  const cfg = loadClassifierConfig(withConfig({ classifier: decisionsCfg({ criteria: { skim: "quick", "bad name": "x", empty: "  " } }) }))!;
  assert.equal(cfg.builtin, "openrouter");
  assert.equal(cfg.model, "typesafe/jev-1.14");
  assert.equal(cfg.timeoutMs, 30_000);
  assert.equal(cfg.fallback, true);
  assert.deepEqual(cfg.criteria, { skim: "quick" }); // invalid entries dropped
  assert.equal(loadClassifierConfig(withConfig({ classifier: decisionsCfg({ criteria: { "bad name": "x" } }) }))?.criteria, undefined);
});

test("resolveApiKey: classifier key > env > llm defaults", () => {
  const cfg = loadClassifierConfig(withConfig({ classifier: decisionsCfg(), defaults: { apiKey: "llm-key" } }))!;
  process.env.OPENROUTER_API_KEY = "env-key";
  assert.equal(resolveApiKey(decisionsCfg() as never, withConfig({ classifier: decisionsCfg(), defaults: { apiKey: "llm-key" } })), "env-key");
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(resolveApiKey(cfg, withConfig({ classifier: decisionsCfg(), defaults: { apiKey: "llm-key" } })), "llm-key");
  const noKey = withConfig({ classifier: decisionsCfg() });
  assert.equal(resolveApiKey(decisionsCfg() as never, noKey), undefined);
});

test("resolveApiKey: OPENAI_API_KEY env for the openai backend", () => {
  process.env.OPENAI_API_KEY = "oa-key";
  assert.equal(resolveApiKey({ builtin: "openai" } as never, withConfig(null)), "oa-key");
  delete process.env.OPENAI_API_KEY;
});

// ---- request building -------------------------------------------------------

test("decisionsRequestBody: one choice question per changed line, criteria attached", () => {
  const cfg = decisionsCfg({ criteria: { skim: "quick", hotspot: "read fully" } })  as never;
  const { body, keyMap } = decisionsRequestBody(request(), cfg);
  const parsed = JSON.parse(body) as { model: string; state: string[]; questions: Record<any, any> };
  assert.equal(parsed.model, "typesafe/jev-1.14");
  assert.equal(Object.keys(parsed.questions).length, 2); // del + add lines
  const q0 = parsed.questions["q0"];
  assert.equal(q0.type, "choice");
  assert.deepEqual(q0.criteria, { skim: "quick", hotspot: "read fully" });
  assert.match(q0.instructions, /src\/auth\.ts \(removed line 1\): "old line"/);
  assert.match(parsed.state[0], /src\/auth\.ts \(modified\)/);
  assert.match(parsed.state[0], /- old line/);
  assert.match(parsed.state[0], /\+ await checkPassword/);
  assert.deepEqual(keyMap.get("q1"), { file: "src/auth.ts", side: "new", line: 2 });
});

test("decisionsRequestBody: semantic chapter title in state + instructions (§8a)", () => {
  const titled = { ...chapter, title: "auth fix" } as Chapter;
  const { body, keyMap } = decisionsRequestBody(request([titled]), decisionsCfg() as never);
  const parsed = JSON.parse(body) as { state: string[]; questions: Record<any, any> };
  assert.match(parsed.state[0], /## "auth fix"/);
  assert.match(parsed.questions.q0.instructions, /Chapter context: "auth fix"/);
  assert.ok(keyMap.size >= 1);
});

test("decisionsRequestBody: default criteria/instructions when not configured", () => {
  const { body } = decisionsRequestBody(request(), decisionsCfg()  as never);
  const q = (JSON.parse(body) as { questions: Record<any, any> }).questions["q0"];
  assert.deepEqual(q.criteria, DEFAULT_CRITERIA);
  assert.match(q.instructions as string, /Which attention mark/);
});

test("decisionsRequestBody: openai — input as shared evidence, array questions with choices", () => {
  const cfg = { builtin: "openai", model: "gpt-6-luna", criteria: { skim: "quick", hotspot: "read fully" } } as never;
  const { body, keyMap } = decisionsRequestBody(request(), cfg);
  const parsed = JSON.parse(body) as { model: string; input: string; questions: Array<Record<string, any>> };
  assert.equal(parsed.model, "gpt-6-luna");
  assert.match(parsed.input, /src\/auth\.ts \(modified\)/);
  assert.match(parsed.input, /\+ await checkPassword/);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0].name, "q0");
  assert.equal(parsed.questions[0].type, "choice");
  assert.deepEqual(parsed.questions[0].choices, [
    { value: "skim", description: "quick" },
    { value: "hotspot", description: "read fully" },
  ]);
  assert.match(parsed.questions[1].instructions, /src\/auth\.ts \(new line 2\)/);
  assert.deepEqual(keyMap.get("q1"), { file: "src/auth.ts", side: "new", line: 2 });
});

// ---- response parsing --------------------------------------------------------

const expectedOf = (req: string) => {
  // coordinates the request carried — same extraction the adapter does
  const parsed = JSON.parse(req) as { chapters: { files: { file: string; hunks: { lines: { side: string; line: number }[] }[] }[] }[] };
  const set = new Set<string>();
  for (const c of parsed.chapters) for (const f of c.files) for (const h of f.hunks) for (const l of h.lines)
    set.add(`${f.file}\u0000${l.side}:${l.line}`);
  return set;
};

test("parseDecisionsResponse: answers → marks; wrong vocabulary and unknown keys skipped", () => {
  const req = request();
  const { keyMap } = decisionsRequestBody(req, decisionsCfg()  as never);
  const raw = JSON.stringify({
    answers: {
      q0: { type: "choice", choice: "safe" },
      q1: { type: "choice", choice: "focus" },
      q2: { type: "choice", choice: "safe" }, // unknown question key
      q0b: { type: "choice", choice: "not-a-mark" }, // not in vocabulary — and dead key anyway
    },
  });
  const marks = parseDecisionsResponse(raw, DEFAULT_CRITERIA, expectedOf(req), keyMap);
  assert.deepEqual(marks, [
    { file: "src/auth.ts", side: "old", line: 1, mark: "safe", markSource: "custom" },
    { file: "src/auth.ts", side: "new", line: 2, mark: "focus", markSource: "custom" },
  ]);
});

test("parseDecisionsResponse: openai array envelope matched by name; refusals skipped", () => {
  const req = request();
  const { keyMap } = decisionsRequestBody(req, { builtin: "openai", model: "gpt-6-luna" } as never);
  const raw = JSON.stringify({
    answers: [
      { type: "choice", name: "q0", choice: "safe" },
      { type: "refusal", name: "q1" }, // no choice — line keeps its rules mark
      { type: "choice", choice: "focus" }, // missing name — dropped
    ],
  });
  const marks = parseDecisionsResponse(raw, DEFAULT_CRITERIA, expectedOf(req), keyMap);
  assert.deepEqual(marks, [
    { file: "src/auth.ts", side: "old", line: 1, mark: "safe", markSource: "custom" },
  ]);
});

test("parseDecisionsResponse: malformed envelope throws", () => {
  assert.throws(() => parseDecisionsResponse("{}", DEFAULT_CRITERIA, new Set(), new Map()), DecisionsError);
  assert.throws(() => parseDecisionsResponse("not json", DEFAULT_CRITERIA, new Set(), new Map()), DecisionsError);
});

// ---- the HTTP boundary --------------------------------------------------------

test("decisionsClassify: ok → marks; custom names survive", async () => {
  const cfg = { ...decisionsCfg({ criteria: { skim: "quick", hotspot: "read fully" } }), apiKey: "cfg-key" };
  const req = request();
  const { keyMap } = decisionsRequestBody(req, cfg);
  const calls: string[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(new URL(url).pathname, "/api/alpha/decisions");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer cfg-key");
    const sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({
      answers: Object.fromEntries([...keyMap.keys()].map((k, i) => [k, { choice: i === 0 ? "skim" : "hotspot" }])),
    }), { status: 200 });
  };
  const root = withConfig({ classifier: { ...cfg, apiKey: "cfg-key" } });
  const run = await decisionsClassify(cfg, root, req, fakeFetch as typeof fetch);
  assert.equal(run.failed, false);
  assert.deepEqual(run.marks, [
    { file: "src/auth.ts", side: "old", line: 1, mark: "skim", markSource: "custom" },
    { file: "src/auth.ts", side: "new", line: 2, mark: "hotspot", markSource: "custom" },
  ]);
  assert.equal(calls.length, 1);
});

test("decisionsClassify: openai endpoint + bearer auth + array answers", async () => {
  const cfg = { builtin: "openai", model: "gpt-6-luna", apiKey: "oa-key", criteria: { skim: "quick" } } as never;
  const req = request();
  const calls: string[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(new URL(url).host, "api.openai.com");
    assert.equal(new URL(url).pathname, "/v1/decisions");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer oa-key");
    const sent = JSON.parse(init.body as string);
    assert.equal(sent.model, "gpt-6-luna");
    assert.ok(Array.isArray(sent.questions));
    return new Response(JSON.stringify({
      answers: [
        { type: "choice", name: "q0", choice: "skim" },
        { type: "choice", name: "q1", choice: "skim" },
      ],
    }), { status: 200 });
  };
  const run = await decisionsClassify(cfg, withConfig(null), req, fakeFetch as typeof fetch);
  assert.equal(run.failed, false);
  assert.equal(run.marks.length, 2);
  assert.deepEqual(run.marks[0], { file: "src/auth.ts", side: "old", line: 1, mark: "skim", markSource: "custom" });
  assert.equal(calls.length, 1);
});

test("decisionsClassify: openai missing key names OPENAI_API_KEY", async () => {
  const run = await decisionsClassify({ builtin: "openai", model: "gpt-6-luna" } as never, withConfig(null), request());
  assert.equal(run.failed, true);
  assert.match(run.error!, /OPENAI_API_KEY/);
});

test("decisionsClassify: HTTP error and missing key degrade to a failed run (no throw)", async () => {
  const run = await decisionsClassify({ ...decisionsCfg(), apiKey: "cfg-key" }   as never, withConfig(null), request(),
    async () => new Response("nope", { status: 502 }) as Response);
  assert.equal(run.failed, true);
  assert.equal(run.error, "HTTP 502");
  const noKey = await decisionsClassify(decisionsCfg()   as never, withConfig({ classifier: decisionsCfg() }), request());
  assert.equal(noKey.failed, true);
  assert.match(noKey.error!, /no api key/);
});

// ---- merge through applyClassifier (shared path, no network) -------------------

test("applyClassifier: decision-backend failure with fallback keeps rules marks; no config → no-op", async () => {
  const root = withConfig({ classifier: decisionsCfg() }); // no key anywhere → failed run
  const chapters = [{ ...chapter, attention: [{ file: "src/auth.ts", side: "new" as const, line: 2, mark: "focus", markSource: "rules" as const }] }];
  await applyClassifier(root, "b1", "h1", chapters);
  assert.equal(chapters[0].attention[0].mark, "focus"); // rules marks survive
  const noConfig = withConfig(null);
  await applyClassifier(noConfig, "b1", "h1", chapters); // must not throw
});
