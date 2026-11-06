// Author identity (spec §15): jj config first, git config fall-through;
// resolved once, cached in memory. Missing config → null → "anonymous".
import { tryRun } from "./cli.ts";

export interface Author {
  name: string;
  email: string;
}

const firstLine = (s: string | null): string | null => {
  const line = s?.trim().split("\n")[0];
  return line || null;
};

// pure core (fixture-tested): jj values win; both name and email required
// for a usable author, else null (the UI shows "anonymous")
export function authorFrom(
  jjName: string | null,
  jjEmail: string | null,
  gitName: string | null,
  gitEmail: string | null,
): Author | null {
  const name = firstLine(jjName) ?? firstLine(gitName);
  const email = firstLine(jjEmail) ?? firstLine(gitEmail);
  return name && email ? { name, email } : null;
}

let cached: Promise<Author | null> | undefined;

export function getIdentity(root: string, kind: "git" | "jj"): Promise<Author | null> {
  cached ??= resolve(root, kind);
  return cached;
}

async function resolve(root: string, kind: "git" | "jj"): Promise<Author | null> {
  // jj config get errors (rather than falling through) on unset keys (D§11) —
  // tryRun catches, so we fall through to git manually here
  const [jjName, jjEmail] =
    kind === "jj"
      ? await Promise.all([
          tryRun("jj", ["config", "get", "user.name"], root),
          tryRun("jj", ["config", "get", "user.email"], root),
        ])
      : [null, null];
  const [gitName, gitEmail] = await Promise.all([
    tryRun("git", ["config", "user.name"], root),
    tryRun("git", ["config", "user.email"], root),
  ]);
  return authorFrom(jjName, jjEmail, gitName, gitEmail);
}
