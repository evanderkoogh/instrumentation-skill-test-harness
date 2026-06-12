import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import {
  harness,
  harnessStart,
  readAppConfig,
  readSkillVersion,
  sleep,
  StartupFailure,
} from "./src/harness.js";
import { runInstrumentation } from "./src/instrumentation.js";
import { evaluate } from "./src/evaluation.js";
import { recordRun, printSummary } from "./src/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const app = process.argv[2];
if (!app) {
  console.error("Usage: npx tsx run.ts <app> [--model <model-id>]");
  process.exit(1);
}

const modelArg = (() => {
  const idx = process.argv.indexOf("--model");
  return idx !== -1 ? process.argv[idx + 1] : undefined;
})();

// Ingest key — forwarded to the instrumentation agent for OTLP export
const ingestKey = (() => {
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  const match = headers.match(/x-honeycomb-team=([^,]+)/);
  return match?.[1] ?? "";
})();

// Query key — used by evaluation to read from Honeycomb REST API
// Must have "Query Data" permission (ingest keys are write-only)
const queryApiKey = process.env.HONEYCOMB_QUERY_API_KEY ?? "";

if (!ingestKey) {
  console.error("OTEL_EXPORTER_OTLP_HEADERS not set in .env");
  process.exit(1);
}
if (!queryApiKey) {
  console.error("HONEYCOMB_QUERY_API_KEY not set in .env (needs Query Data permission)");
  process.exit(1);
}

async function main(): Promise<void> {
  const { dataset } = readAppConfig(app);
  const timestamp = new Date().toISOString();

  console.log(`\n▶ Run: ${app}  dataset: ${dataset}${modelArg ? `  model: ${modelArg}` : ""}`);

  // --- Setup ---
  console.log("→ reset --purge");
  harness(app, "reset", "--purge");

  console.log("→ build");
  harness(app, "build");

  console.log("→ bootstrap");
  harness(app, "bootstrap");

  console.log("→ instrument");
  harness(app, "instrument");

  const skill = readSkillVersion(app);
  console.log(`  skill: ${skill.branch} @ ${skill.sha}`);

  // --- Instrumentation agent ---
  console.log("→ running instrumentation agent");
  const agentMetrics = await runInstrumentation(app, ingestKey, modelArg);
  console.log(
    `  done: ${agentMetrics.tool_uses} tool calls · ${agentMetrics.total_tokens} tokens · ${(agentMetrics.duration_ms / 1000).toFixed(1)}s`
  );

  // Re-write .skill-version: the agent may have overwritten it with its own content
  const versionPath = resolve(__dirname, "checkouts", app, ".skill-version");
  writeFileSync(
    versionPath,
    `SKILL_BRANCH=${skill.branch}\nSKILL_SHA=${skill.sha}\nSKILL_COMMIT_MSG="${skill.commit}"\n`
  );

  const baseRecord = {
    timestamp,
    app,
    model: agentMetrics.model,
    skill_branch: skill.branch,
    skill_sha: skill.sha,
    skill_commit: skill.commit,
    agent: agentMetrics,
  };

  // --- Start ---
  console.log("→ start");
  harness(app, "stop");  // no-op if nothing is running; clears stale PID file
  try {
    harnessStart(app);
  } catch (err) {
    if (err instanceof StartupFailure) {
      const record = {
        ...baseRecord,
        failed: true,
        failure_reason: err.reason,
        criteria: undefined,
      };
      recordRun(record);
      printSummary(record);
      harness(app, "stop");
      return;
    }
    throw err;
  }

  // --- Traffic + flush ---
  console.log("→ traffic");
  harness(app, "traffic");
  console.log("→ waiting 15s for spans to flush");
  await sleep(15_000);

  // --- Evaluate ---
  console.log("→ evaluating");
  const criteria = await evaluate(dataset, queryApiKey);

  const record = {
    ...baseRecord,
    failed: false,
    failure_reason: null,
    criteria,
  };
  recordRun(record);
  printSummary(record);

  harness(app, "stop");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
