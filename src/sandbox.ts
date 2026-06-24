import { resolve, relative, isAbsolute, sep } from "path";
import { homedir } from "os";

// Hard filesystem sandbox for the instrumentation agent.
//
// The agent is given an unrestricted Bash tool so it can build and verify its own
// instrumentation (mvn / go / uv all need system toolchains, dependency caches, the
// network, and /tmp). But it must NOT be able to read the test harness's own files —
// `src/evaluation.ts`, `EVALUATION.md`, `harness.sh`, the collector/weaver config, other
// apps' checkouts — because that's the answer key, and reading it lets the agent overfit
// the eval instead of instrumenting well.
//
// So we allow everything OUTSIDE the harness tree (system, caches, $HOME, /tmp) and, inside
// the harness tree, allow only the app's own checkout plus `otel/` (the bundled weaver the
// skill self-validates with). Everything else under the harness root is blocked.

export interface GuardContext {
  /** The app's checkout — the only harness-internal tree the agent may read/write. */
  repoDir: string;
  /** The test harness repo root. */
  harnessRoot: string;
}

export interface GuardVerdict {
  allow: boolean;
  /** The offending path, when blocked (for the deny message + audit log). */
  target?: string;
}

// True when `child` is `parent` itself or nested beneath it. Note the escape check matches
// the ".." path *segment* (".." alone or ".." + separator), not the ".." prefix — otherwise a
// literal segment like Go's "..." in `./...` would be misread as a parent escape.
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

// Whitespace/operator-separated tokens that look like filesystem paths (contain a slash or
// a parent escape). Quotes are stripped so `"../../src"` is inspected too.
function pathTokens(command: string): string[] {
  return command
    .split(/[\s;|&()<>="'`]+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
    .filter((t) => t.length > 0 && (/[\\/]/.test(t) || t === ".." || t.startsWith("../")));
}

// `cd`/`pushd` targets — a command can escape into the harness before touching a file
// (e.g. `cd ../.. && cat EVALUATION.md`), so the destination itself is checked.
function cdTargets(command: string): string[] {
  const out: string[] = [];
  const re = /\b(?:cd|pushd)\s+(?:-[A-Za-z]+\s+)*("[^"]*"|'[^']*'|[^\s;|&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1].replace(/^['"]+|['"]+$/g, ""));
  }
  return out;
}

export function makeFsGuard(ctx: GuardContext) {
  const otelDir = resolve(ctx.harnessRoot, "otel");
  const allowedRoots = [ctx.repoDir, otelDir];
  // The agent's plugins live here. The harness injects the LIVE honeycomb plugin through the
  // runtime, so the agent never needs to read plugin files directly — and a stale, globally
  // installed copy under `cache/` would mislead it (and silently invalidate the run) if it did.
  // Block the whole tree: prevention is durable where deletion isn't (Claude Code re-creates it).
  const pluginsDir = resolve(homedir(), ".claude", "plugins");
  const pluginCacheDir = resolve(pluginsDir, "cache");

  // A skill's `references/` files (e.g. skills/<name>/references/<lang>.md) are real skill content
  // the agent is *meant* to read — but, unlike SKILL.md, the runtime does NOT inject them, so the
  // agent can only get them by reading the file. Allow that (whether it resolves the live plugin
  // path or the harness's agent-skill copy), with two safeguards: never from the stale plugin
  // *cache* (a globally-installed copy would mislead/invalidate the run), and it can't expose the
  // eval answer key, which never lives in a skills/.../references/ path (EVALUATION.md and
  // src/evaluation.ts are elsewhere in the harness tree). SKILL.md itself stays blocked — it
  // reaches the agent through the runtime, not by reading the file.
  const isSkillReference = (absPath: string): boolean => {
    if (isInside(pluginCacheDir, absPath)) return false;
    return /(?:^|\/)skills\/[^/]+\/references\/[^/]+/.test(absPath);
  };

  // Blocked = the agent's plugins tree, OR inside the harness tree but not in an allowed root —
  // except a skill's reference files, which are allowed (see isSkillReference).
  // Other paths outside the harness (system libs, dep caches, /tmp, the rest of $HOME) are fine.
  const isBlocked = (absPath: string): boolean => {
    if (isSkillReference(absPath)) return false;
    if (isInside(pluginsDir, absPath)) return true;
    if (!isInside(ctx.harnessRoot, absPath)) return false;
    return !allowedRoots.some((root) => isInside(root, absPath));
  };

  // Relative paths resolve against the agent's cwd (the checkout).
  const toAbs = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(ctx.repoDir, p));

  function inspect(toolName: string, toolInput: unknown): GuardVerdict {
    const input = (toolInput ?? {}) as Record<string, unknown>;

    if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
      const fp = input.file_path;
      if (typeof fp === "string" && isBlocked(toAbs(fp))) return { allow: false, target: fp };
      return { allow: true };
    }

    if (toolName === "Bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      for (const t of [...cdTargets(cmd), ...pathTokens(cmd)]) {
        if (isBlocked(toAbs(t))) return { allow: false, target: t };
      }
      return { allow: true };
    }

    return { allow: true };
  }

  return { inspect, isBlocked };
}

export function denyReason(target: string): string {
  // Reading plugin definitions directly (live or, worse, a stale cached copy under
  // ~/.claude/plugins/cache) is never legitimate — skills and agents reach the agent through
  // the runtime, not by reading their markdown. Blocking the whole plugins tree also prevents
  // a stale cached honeycomb plugin from contaminating the run, durably (deleting the cache
  // doesn't help — Claude Code re-creates it).
  if (target.includes("/.claude/plugins/")) {
    return (
      `Sandbox: reading plugin files at "${target}" is blocked. Use the skills and agents you ` +
      `were given through the runtime — do not read skill/agent/plugin source files directly. ` +
      `(Cached plugin copies on disk may be stale and would mislead you.)`
    );
  }
  return (
    `Sandbox: access to "${target}" is blocked. You may only read and write within your ` +
    `own checkout directory (and invoke the bundled \`weaver\` in otel/). The test harness's ` +
    `own files — evaluation code, EVALUATION.md, harness.sh, collector/weaver config, other ` +
    `apps' checkouts — are off-limits. Do not attempt to read them; instrument the application ` +
    `on its merits.`
  );
}
