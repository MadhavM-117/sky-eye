// Diff generation (spec §7.1) and unified-diff parsing (spec §7.2). Pure parsing.
import { createHash } from "node:crypto";
import { run } from "./cli.ts";
import type { DiffLine, DiffLineType, FileDiff, Hunk } from "./types.ts";

export async function buildDiff(
  root: string,
  kind: "git" | "jj",
  base: string,
  head: string,
): Promise<string> {
  // three-dot everywhere (spec §22.6 decision); renames off (spec §7.1)
  if (kind === "jj") {
    return run(
      "jj",
      ["diff", "--git", "--color", "never", "--context", "3", "--from", base, "--to", head],
      root,
    );
  }
  return run(
    "git",
    ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3",
      "--end-of-options", `${base}...${head}`, "--"],
    root,
  );
}

export function diffDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT = /^diff --git a\/(.*) b\/(.*)$/;

// `--- a/<path>` / `--- <path>` — strip the a/ b/ prefix; /dev/null stays
function stripPathPrefix(s: string): string {
  return s === "/dev/null" ? s : s.replace(/^[ab]\//, "").trim();
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldPath = "";
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      hunk = null;
      // binary diffs carry no ---/+++ lines — create the file entry here;
      // ---/+++ lines refine status/paths below
      const m = raw.match(DIFF_GIT);
      if (m) {
        cur = {
          path: m[2],
          oldPath: m[1],
          status: "modified",
          hunks: [],
          binary: false,
        };
        files.push(cur);
      }
      continue;
    }
    if (raw.startsWith("--- ")) {
      hunk = null;
      oldPath = stripPathPrefix(raw.slice(4));
      if (cur) cur.oldPath = oldPath;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const newPath = stripPathPrefix(raw.slice(4));
      const deleted = newPath === "/dev/null";
      if (cur) {
        if (deleted) cur.path = oldPath;
        else cur.path = newPath;
        cur.status =
          oldPath === "/dev/null" ? "added" : deleted ? "deleted" : "modified";
      }
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      if (cur && cur.hunks.length === 0) cur.binary = true;
      continue;
    }
    const hm = raw.match(HUNK_HEADER);
    if (hm && cur) {
      hunk = {
        header: raw,
        oldStart: parseInt(hm[1], 10),
        oldLines: hm[2] === undefined ? 1 : parseInt(hm[2], 10),
        newStart: parseInt(hm[3], 10),
        newLines: hm[4] === undefined ? 1 : parseInt(hm[4], 10),
        lines: [],
      };
      cur.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk || !cur) continue;
    if (raw === "\\ No newline at end of file") continue;
    let type: DiffLineType;
    if (raw.startsWith("+")) type = "add";
    else if (raw.startsWith("-")) type = "del";
    else if (raw.startsWith(" ")) type = "ctx";
    else continue; // not part of a hunk payload
    const line: DiffLine = { type, text: raw.slice(1) };
    if (type !== "add") line.oldLine = oldLine++;
    if (type !== "del") line.newLine = newLine++;
    hunk.lines.push(line);
  }
  return files;
}
