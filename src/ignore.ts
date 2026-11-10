// Ensure .sky-eye/ stays out of git/jj/docker (spec §6).
import fs from "node:fs";
import path from "node:path";

export function upsertIgnoreFile(root: string, name: string, create: boolean) {
  const p = path.join(root, name);
  try {
    if (!fs.existsSync(p)) {
      if (!create) return; // never create .dockerignore (spec §6)
      fs.writeFileSync(p, ".sky-eye/\n");
      return;
    }
    const lines = fs.readFileSync(p, "utf8").split("\n");
    if (lines.some((l) => /^\s*\.sky-eye\/?\s*$/.test(l))) return;
    if (lines.at(-1) !== "") lines.push("");
    lines.push(".sky-eye/");
    // join drops the final newline — re-add it
    fs.writeFileSync(p, lines.join("\n") + "\n");
  } catch (e) {
    console.warn(`sky-eye: could not update ${name}: ${(e as Error).message}`);
  }
}
