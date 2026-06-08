import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
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
  console.error("Usage: npx tsx run.ts <app>");
  process.exit(1);
}

const apiKey = (() => {
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  const match = headers.match(/x-honeycomb-team=([^,]+)/);
  return match?.[1] ?? "";
})();

if (!apiKey) {
  console.error("OTEL_EXPORTER_OTLP_HEADERS not set in .env");
  process.exit(1);
}

async function main(): Promise<void> {
  const { dataset } = readAppConfig(app);
  const timestamp = new Date().toISOString();

  console.log(`\n▶ Run: ${app}  dataset: ${dataset}`);

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
  const agentMetrics = await runInstrumentation(app, apiKey);
  console.log(
    `  done: ${agentMetrics.tool_uses} tool calls · ${agentMetrics.total_tokens} tokens · ${(agentMetrics.duration_ms / 1000).toFixed(1)}s`
  );

  const baseRecord = {
    timestamp,
    app,
    skill_branch: skill.branch,
    skill_sha: skill.sha,
    skill_commit: skill.commit,
    agent: agentMetrics,
  };

  // --- Start ---
  console.log("→ start");
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
  const criteria = await evaluate(dataset, apiKey);

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
