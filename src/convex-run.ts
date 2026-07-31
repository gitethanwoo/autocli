import { spawnSync } from "node:child_process";

export interface RunOptions {
  projectDir: string;
  prod: boolean;
}

export class ConvexRunError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * Calls an autocli internal function via `npx convex run`. Deployment
 * selection follows convex CLI conventions (.env.local / CONVEX_DEPLOYMENT);
 * --prod must be explicit.
 */
export function convexRun(fn: string, args: Record<string, unknown>, opts: RunOptions): unknown {
  const argv = ["convex", "run", ...(opts.prod ? ["--prod"] : []), `autocli:${fn}`, JSON.stringify(args)];
  const res = spawnSync("npx", argv, {
    cwd: opts.projectDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (res.error) throw new ConvexRunError(`Failed to spawn npx convex run: ${res.error.message}`, "");
  if (res.status !== 0) {
    const err = (res.stderr ?? "").trim();
    throw new ConvexRunError(summarizeConvexError(err), err);
  }
  return parseResult(res.stdout ?? "");
}

/** convex run may print log lines before the JSON result; parse from the first JSON opener. */
function parseResult(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const idx = trimmed.search(/[[{]/);
    if (idx >= 0) {
      try {
        return JSON.parse(trimmed.slice(idx));
      } catch {
        // fall through
      }
    }
    throw new ConvexRunError(`Could not parse convex run output:\n${trimmed.slice(0, 800)}`, "");
  }
}

function summarizeConvexError(stderr: string): string {
  if (/Could not find.*autocli/i.test(stderr) || /not found/i.test(stderr)) {
    return "The autocli functions are not deployed. Run `npx convex dev` (or deploy) so convex/autocli.ts is pushed, then retry.";
  }
  if (/not currently logged in|log in|authenticat/i.test(stderr)) {
    return "Convex CLI is not authenticated for this project. Run `npx convex dev` once to set it up.";
  }
  const line = stderr.split("\n").find((l) => l.trim().length > 0) ?? "convex run failed";
  return line.trim();
}
