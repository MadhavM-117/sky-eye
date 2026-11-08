// Semantic chapter grouping (spec §8a): one LLM call over a compact hunk
// inventory → titled chapters. Degrade contract (§16.1): no adapter, a
// failed/malformed call, or an oversized inventory falls back to the pure
// chunker — the session never blocks on the LLM layer.
import { chapterId, changedLines, chunk, funcOf } from "./chunker.ts";
import type { Chapter, FileDiff, FileSlice, Hunk, LlmAdapter, LlmRequest, ReviewConfig } from "./types.ts";

// prompt-size circuit breaker (§8a.1): chunking a monster diff semantically
// is worse than the heuristic
export const MAX_HUNKS = 2000;
export const MAX_INVENTORY_CHARS = 400_000;
const HUNK_TEXT_CAP = 40; // changed lines kept per hunk in the inventory

export interface InventoryEntry {
  id: string;
  file: string;
  status: FileDiff["status"];
  funcname: string | null;
  hunk: Hunk;
  changed: number;
  text: string; // capped changed-line text (+/- prefixed)
}

interface HunkRef {
  file: string;
  status: FileDiff["status"];
  hunk: Hunk;
}

export interface HunkGroup {
  title?: string;
  hunks: HunkRef[];
}

// ---- inventory + prompts (pure) -------------------------------------------

// hunk ids h0…hN-1 in path-then-position order — the same order the pure
// chunker walks, so fallback leftovers line up naturally
export function hunkInventory(files: FileDiff[]): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.binary) continue;
    for (const hunk of file.hunks) {
      const changed = hunk.lines.filter((l) => l.type !== "ctx");
      const text =
        changed
          .slice(0, HUNK_TEXT_CAP)
          .map((l) => (l.type === "add" ? "+" : "-") + l.text)
          .join("\n") +
        (changed.length > HUNK_TEXT_CAP
          ? `\n… (${changed.length - HUNK_TEXT_CAP} more changed lines)`
          : "");
      out.push({
        id: `h${out.length}`,
        file: file.path,
        status: file.status,
        funcname: funcOf(hunk),
        hunk,
        changed: changed.length,
        text,
      });
    }
  }
  return out;
}

export function chunkSystemPrompt(): string {
  return (
    "You group the hunks of a code review diff into chapters, each covering " +
    "one semantic change of the diff. Order chapters the way a reviewer " +
    "should read them. Aim for ~50-100 changed lines per chapter; never " +
    'exceed the given maximum. Reply with ONLY a JSON object: {"chapters": ' +
    '[{"title": "short label", "hunks": ["h0", "h3"]}]}. Use every hunk id ' +
    "exactly once."
  );
}

export function chunkUserPrompt(inventory: InventoryEntry[], config: ReviewConfig): string {
  const lines = inventory.map((e) => {
    const head = `${e.id}  ${e.file} (${e.status})  ${e.funcname ?? "?"}  +${e.changed} changed`;
    return `${head}\n${e.text}`;
  });
  return (
    `Group these hunks into chapters. Max ${config.maxLines} changed lines per chapter.\n\n` +
    lines.join("\n\n")
  );
}

// ---- response parsing + grouping (pure) -----------------------------------

export class ChunkParseError extends Error {}

export function parseChunkResponse(
  raw: string,
  ids: string[],
): { title?: string; hunks: string[] }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChunkParseError("response is not valid JSON");
  }
  const chapters = (parsed as { chapters?: unknown }).chapters;
  if (!Array.isArray(chapters)) throw new ChunkParseError("no chapters array");
  const valid = new Set(ids);
  const out: { title?: string; hunks: string[] }[] = [];
  for (const c of chapters) {
    const o = c as { title?: unknown; hunks?: unknown };
    const title =
      typeof o.title === "string" && o.title.trim()
        ? o.title.trim().slice(0, 80)
        : undefined;
    const hunks = Array.isArray(o.hunks)
      ? o.hunks.filter((h): h is string => typeof h === "string" && valid.has(h))
      : [];
    out.push({ title, hunks });
  }
  return out;
}

// map parsed id-groups back to hunks; duplicates → first group wins,
// unknown ids dropped (leftovers land in the fallback chunker)
export function groupHunks(inventory: InventoryEntry[], parsed: { title?: string; hunks: string[] }[]): HunkGroup[] {
  const byId = new Map(inventory.map((e) => [e.id, e]));
  const used = new Set<string>();
  return parsed.map((g) => {
    const hunks: HunkRef[] = [];
    for (const id of g.hunks) {
      if (used.has(id)) continue;
      const e = byId.get(id);
      if (!e) continue;
      used.add(id);
      hunks.push({ file: e.file, status: e.status, hunk: e.hunk });
    }
    return { title: g.title, hunks };
  });
}

// ---- chapter building -------------------------------------------------------

// one contiguous slice per file, in path order (§8 shape); hunks sorted by
// position within a file regardless of the order the model listed them
function slicesOf(refs: HunkRef[]): FileSlice[] {
  const byFile = new Map<string, FileSlice>();
  for (const r of [...refs].sort(
    (a, b) => a.file.localeCompare(b.file) || a.hunk.newStart - b.hunk.newStart,
  )) {
    let s = byFile.get(r.file);
    if (!s) byFile.set(r.file, (s = { file: r.file, status: r.status, hunks: [] }));
    s.hunks.push(r.hunk);
  }
  return [...byFile.values()];
}

// minimal FileDiffs so the pure chunker can re-split a group (binary hunks
// never reach the inventory; oldPath unused by the chunker)
function fileDiffsOf(refs: HunkRef[]): FileDiff[] {
  const byFile = new Map<string, FileDiff>();
  for (const r of refs) {
    let f = byFile.get(r.file);
    if (!f) byFile.set(r.file, (f = { path: r.file, oldPath: r.file, status: r.status, hunks: [], binary: false }));
    f.hunks.push(r.hunk);
  }
  return [...byFile.values()];
}

export function buildChapters(
  files: FileDiff[],
  groups: HunkGroup[],
  config: ReviewConfig,
): Chapter[] {
  const used = new Set(groups.flatMap((g) => g.hunks.map((r) => r.hunk)));
  const chapters: Chapter[] = [];
  for (const group of groups) {
    if (!group.hunks.length) continue;
    const lines = group.hunks.reduce((n, r) => n + changedLines(r.hunk), 0);
    if (lines > config.maxLines) {
      // guardrail (§8a.4): re-split by the pure chunker — title only on the
      // first part, and the renderer's maxLines guarantee survives
      chunk(fileDiffsOf(group.hunks), config).forEach((c, i) => {
        if (i === 0 && group.title) chapters.push({ ...c, title: group.title });
        else chapters.push(c);
      });
      continue;
    }
    const slices = slicesOf(group.hunks);
    chapters.push({
      id: chapterId(slices),
      files: slices,
      narrative: "unanalyzed",
      title: group.title,
      attention: [],
    });
  }
  // leftovers (model missed them) → pure chunker, appended at the end
  const rest: HunkRef[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    for (const hunk of file.hunks)
      if (!used.has(hunk)) rest.push({ file: file.path, status: file.status, hunk });
  if (rest.length) chapters.push(...chunk(fileDiffsOf(rest), config));
  return chapters;
}

// ---- orchestration -----------------------------------------------------------

// same degrade wrapper as narrate.ts: any failure → undefined, console one-liner
async function call(adapter: LlmAdapter, req: LlmRequest): Promise<string | undefined> {
  try {
    return await adapter.call(req);
  } catch (e) {
    console.error(`sky-eye: llm ${req.task} failed: ${(e as Error).message}`);
    return undefined;
  }
}

// undefined = use the pure chunker (fallback, §8a degradation)
export async function semanticChunk(
  adapter: LlmAdapter,
  files: FileDiff[],
  config: ReviewConfig,
): Promise<Chapter[] | undefined> {
  const inventory = hunkInventory(files);
  if (!inventory.length || inventory.length > MAX_HUNKS) return undefined;
  if (inventory.reduce((n, e) => n + e.text.length, 0) > MAX_INVENTORY_CHARS) return undefined;
  const raw = await call(adapter, {
    task: "chunk",
    system: chunkSystemPrompt(),
    prompt: chunkUserPrompt(inventory, config),
  });
  if (raw === undefined) return undefined;
  try {
    const parsed = parseChunkResponse(raw, inventory.map((e) => e.id));
    return buildChapters(files, groupHunks(inventory, parsed), config);
  } catch (e) {
    console.error(`sky-eye: llm chunk response malformed — using the pure chunker: ${(e as Error).message}`);
    return undefined;
  }
}
