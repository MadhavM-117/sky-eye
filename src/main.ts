// Entry: repo detect → ignore upkeep → server start → browser open (spec §4.1).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { upsertIgnoreFile } from "./ignore.ts";
import { serve } from "./server.ts";
import "./routes.ts";

function findRoot(dir: string): string | null {
  if (
    fs.existsSync(path.join(dir, ".jj")) ||
    fs.existsSync(path.join(dir, ".git"))
  )
    return dir;
  const parent = path.dirname(dir);
  return parent === dir ? null : findRoot(parent);
}

const root = findRoot(process.cwd());
if (!root) {
  console.error(
    `sky-eye: no git or .jj repo found in ${process.cwd()}\n` +
      `run sky-eye inside a repository.`,
  );
  process.exit(1);
}
const kind = fs.existsSync(path.join(root, ".jj")) ? "jj" : "git"; // jj wins for colocated

upsertIgnoreFile(root, ".gitignore", true);
upsertIgnoreFile(
  root,
  ".dockerignore",
  fs.existsSync(path.join(root, ".dockerignore")),
);

const { port } = await serve(root, kind);
console.log(
  `sky-eye serving ${root} (${kind} repo) → http://localhost:${port}`,
);

const url = `http://localhost:${port}`;
const opener = process.platform === "darwin" ? "open" : "xdg-open";
execFile(opener, [url], (err) => {
  if (err) console.warn(`sky-eye: could not open browser — visit ${url}`);
});
