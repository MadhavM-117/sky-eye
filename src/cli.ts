// The one module that knows how to run git/jj. shell:false everywhere (spec §4.2).
import { execFile } from "node:child_process";

export class ApiError extends Error {
  status: number;
  payload?: unknown; // extra JSON body (e.g. 409 carries the current session)
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export const VALID_REF = /^[0-9a-zA-Z@][0-9a-zA-Z._/@+-]*$/;

export function validateRef(ref: string): string {
  if (!VALID_REF.test(ref)) throw new ApiError(400, `invalid ref: ${ref}`);
  return ref;
}

export function run(
  cmd: "git" | "jj",
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

// fire-and-catch for discovery gaps (spec §5 empty-data rule)
export async function tryRun(
  cmd: "git" | "jj",
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    return await run(cmd, args, cwd);
  } catch {
    return null;
  }
}
