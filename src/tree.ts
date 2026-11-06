// File explorer data: directory listing + file content at a ref (spec §11).
// Content comes from the VCS object store, never the working tree.
import { run, tryRun } from "./cli.ts";

export interface TreeEntry {
  name: string;
  type: "dir" | "file";
  path: string;
}

export async function listTree(
  root: string,
  kind: "git" | "jj",
  ref: string,
  dir: string,
): Promise<TreeEntry[]> {
  const normalized = dir === "" || dir === "." ? "" : dir.replace(/\/$/, "") + "/";
  if (kind === "jj") return jjTree(root, ref, normalized);
  return gitTree(root, ref, normalized);
}

async function gitTree(root: string, ref: string, prefix: string): Promise<TreeEntry[]> {
  const out = await run(
    "git",
    ["ls-tree", "--end-of-options", ref, "--", prefix === "" ? "." : prefix],
    root,
  );
  const entries: TreeEntry[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [meta, entryPath] = line.split("\t");
    const type = meta.split(" ")[1];
    // ls-tree lists the given dir, so entryPath is relative to it — re-apply prefix
    const name = entryPath.split("/").at(-1) ?? entryPath;
    entries.push({
      name,
      type: type === "tree" ? "dir" : "file",
      path: prefix + entryPath,
    });
  }
  return entries;
}

async function jjTree(root: string, ref: string, prefix: string): Promise<TreeEntry[]> {
  // `jj file list` emits recursive file paths only — synthesize the top level.
  const out = await run("jj", ["file", "list", "-r", ref, "--", prefix], root);
  const entries = new Map<string, TreeEntry>();
  for (const p of out.split("\n").filter(Boolean)) {
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      entries.set(p, { name: rest, type: "file", path: p });
    } else {
      const name = rest.slice(0, slash);
      const dirPath = prefix + name;
      if (!entries.has(dirPath))
        entries.set(dirPath, { name, type: "dir", path: dirPath });
    }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function readFileAt(
  root: string,
  kind: "git" | "jj",
  ref: string,
  p: string,
): Promise<{ content: string; binary: boolean }> {
  const out =
    kind === "jj"
      ? await run("jj", ["file", "show", "-r", ref, "--", p], root)
      : await run("git", ["cat-file", "-p", `${ref}:${p}`], root);
  const binary = out.slice(0, 8000).includes("\0");
  return { content: binary ? "" : out, binary };
}
