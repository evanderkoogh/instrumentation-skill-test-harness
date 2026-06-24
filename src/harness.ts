import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(__dirname, "..", "harness.sh");

export class HarnessError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly stderr: string
  ) {
    super(`harness.sh ${cmd} failed:\n${stderr}`);
  }
}

export class StartupFailure extends Error {
  constructor(public readonly reason: string) {
    super(`Startup failed:\n${reason}`);
  }
}

export function harness(app: string, ...args: string[]): string {
  const result = spawnSync(HARNESS, [app, ...args], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new HarnessError(`${app} ${args.join(" ")}`, detail);
  }
  return result.stdout ?? "";
}

export function harnessStart(app: string, runId?: string): void {
  const result = spawnSync(HARNESS, [app, "start"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    // Pass the run id so the collector stamps harness.run_id on every span
    // (collector.run.template.yaml), letting the eval scope its queries to this run.
    env: runId ? { ...process.env, HARNESS_RUN_ID: runId } : process.env,
  });
  if (result.status !== 0) {
    // Capture everything useful, not just stderr: `harness.sh start` logs its phases to stdout
    // and may fail with an empty stderr (or be killed by a signal), which left the run's
    // failure_reason blank and the failure unactionable. Include stdout, stderr, the spawn error,
    // and how it exited, and never throw a blank reason.
    const reason =
      [
        result.stderr?.trim(),
        result.stdout?.trim(),
        result.error ? `spawn error: ${result.error.message}` : "",
        result.status !== null ? `exit code ${result.status}` : "",
        result.signal ? `killed by signal ${result.signal}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "harness.sh start failed with no captured output";
    throw new StartupFailure(reason);
  }
}

// Bring up the per-run agent-telemetry collector (harness.sh agent-collector-start) and return
// the OTLP endpoint the SDK exporter should target, or undefined if it couldn't start. The SDK
// runs in THIS process, so harness.sh publishes its dynamically-allocated port to a file we read
// back here. Best-effort: any failure returns undefined and the caller exports straight to
// Honeycomb (un-remapped) instead of aborting the run.
export function startAgentCollector(app: string, runId: string): string | undefined {
  const endpointFile = resolve(
    __dirname,
    "..",
    "tmp",
    `.harness.${app}.agent-collector.endpoint`
  );
  const result = spawnSync(HARNESS, [app, "agent-collector-start"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    // Pass the run id so the collector stamps it as gen_ai.conversation.id (collector.agent.template.yaml).
    env: { ...process.env, HARNESS_RUN_ID: runId },
  });
  if (result.status !== 0) return undefined;
  try {
    const endpoint = readFileSync(endpointFile, "utf8").trim();
    return endpoint || undefined;
  } catch {
    return undefined;
  }
}

export function stopAgentCollector(app: string): void {
  spawnSync(HARNESS, [app, "agent-collector-stop"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
}

export function readAppConfig(app: string): { dataset: string; language: string } {
  const configPath = resolve(__dirname, "..", "apps", app, "config.sh");
  const content = readFileSync(configPath, "utf8");
  const dataset = content.match(/APP_DATASET="([^"]+)"/)?.[1] ?? app;
  // APP_OTEL_AGENT_TYPE is the app's language/runtime (python|go|java|node) — it selects the
  // containerized agent image (src/container.ts). Falls back to "node" if unset.
  const language = content.match(/APP_OTEL_AGENT_TYPE="([^"]+)"/)?.[1] ?? "node";
  return { dataset, language };
}

export function readSkillVersion(app: string): {
  branch: string;
  sha: string;
  commit: string;
  contentHash: string;
  uncommitted: boolean;
} {
  try {
    const versionPath = resolve(__dirname, "..", "checkouts", app, ".skill-version");
    const content = readFileSync(versionPath, "utf8");
    const branch = content.match(/SKILL_BRANCH=(.+)/)?.[1]?.trim() ?? "unknown";
    const sha = content.match(/SKILL_SHA=(.+)/)?.[1]?.trim() ?? "unknown";
    const commit =
      content.match(/SKILL_COMMIT_MSG="(.+)"/)?.[1]?.trim() ?? "unknown";
    // content_hash reflects the live (incl. uncommitted) skill files actually loaded —
    // the git SHA can't, so this is the authoritative version id. See harness.sh instrument.
    const contentHash = content.match(/SKILL_CONTENT_HASH=(.+)/)?.[1]?.trim() ?? "unknown";
    const uncommitted = content.match(/SKILL_UNCOMMITTED=(.+)/)?.[1]?.trim() === "true";
    return { branch, sha, commit, contentHash, uncommitted };
  } catch {
    return { branch: "unknown", sha: "unknown", commit: "unknown", contentHash: "unknown", uncommitted: false };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
