// In-container entrypoint for the instrumentation agent (HARNESS_CONTAINERIZE=1).
//
// run.ts (host) launches this via `docker run … src/run-agent.ts <app>`. It is a thin wrapper around
// the SAME runInstrumentation() used on the host — the agent logic is identical; only the process /
// network namespace differs. The container replicates the harness path layout (/harness), so
// runInstrumentation resolves repoDir / pluginRoot exactly as it does on the host (see
// docker/agent-python.Dockerfile and the plan).
//
// Inputs arrive via argv (app) + env (run id, collector endpoint, model, skill metadata, auth). The
// returned AgentMetrics are written to the bind-mounted tmp/.agent-metrics.<app>.json, which the host
// reads back (src/container.ts) — that file IS the channel out of the container.
import { runInstrumentation, type SkillVersion } from "./instrumentation.js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: run-agent.ts <app>  (run id + config come from HARNESS_* env)");
    process.exit(1);
  }
  const runId = process.env.HARNESS_RUN_ID;
  if (!runId) {
    console.error("HARNESS_RUN_ID is required");
    process.exit(1);
  }
  const collectorEndpoint = process.env.HARNESS_COLLECTOR_ENDPOINT || undefined;
  const model = process.env.HARNESS_MODEL || undefined;
  // Ingest key for the direct-to-Honeycomb fallback (used only if collectorEndpoint is unset).
  const ingestKey =
    process.env.HARNESS_INGEST_KEY ||
    (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").match(/x-honeycomb-team=([^,]+)/)?.[1] ||
    "";

  // Skill version is computed host-side (real git repo) and passed in as env so this stays
  // self-contained — no git, no .skill-version read needed here. Tags the agent telemetry's skill.*
  // resource attributes, which the A/B comparison keys off.
  const skill: SkillVersion | undefined = process.env.HARNESS_SKILL_SHA
    ? {
        branch: process.env.HARNESS_SKILL_BRANCH ?? "unknown",
        sha: process.env.HARNESS_SKILL_SHA ?? "unknown",
        commit: process.env.HARNESS_SKILL_COMMIT ?? "unknown",
        contentHash: process.env.HARNESS_SKILL_CONTENT_HASH ?? "unknown",
        uncommitted: process.env.HARNESS_SKILL_UNCOMMITTED === "true",
        description: process.env.HARNESS_SKILL_DESCRIPTION || undefined,
      }
    : undefined;

  const metrics = await runInstrumentation(app, ingestKey, runId, collectorEndpoint, model, skill);

  // Let the SDK's OTLP exporter flush its final spans to the (host) collector before the process
  // exits — the exporter lives in THIS process, so exiting immediately would drop in-flight spans.
  // Mirrors the post-run flush wait run.ts does on the host path.
  if (collectorEndpoint) await new Promise((r) => setTimeout(r, 3000));

  const outPath = resolve(__dirname, "..", "tmp", `.agent-metrics.${app}.json`);
  writeFileSync(outPath, JSON.stringify(metrics));
  console.log(`[run-agent] wrote agent metrics → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
