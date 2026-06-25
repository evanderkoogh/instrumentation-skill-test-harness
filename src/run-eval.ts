// In-container evaluation/scoring entrypoint (container-only mode).
//
// Invoked by the in-container lifecycle (docker/lifecycle.sh) as the final step of a run, after the
// app + fan-out collector + weaver have run and traffic has flushed. It is a thin wrapper around the
// shared evaluateAll(). This is "harness mode": trusted harness code with NO sandbox (unlike
// run-agent.ts), so it reads the eval answer key freely.
//
// Inputs arrive via argv (app) + env (HARNESS_RUN_ID, HARNESS_DATASET, HONEYCOMB_QUERY_API_KEY, and —
// set by lifecycle.sh — HARNESS_WEAVER_ADMIN_PORT/HARNESS_WEAVER_REGISTRY for the weaver finalize).
// The result is written to the bind-mounted tmp/.eval-results.<app>.json, which the host reads back
// (src/container.ts runLifecycleInContainer) — that file IS the channel out of the container.
import { evaluateAll } from "./evaluation.js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, "..");

async function main(): Promise<void> {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: run-eval.ts <app>  (run id + config come from HARNESS_* env)");
    process.exit(1);
  }
  const runId = process.env.HARNESS_RUN_ID;
  if (!runId) {
    console.error("HARNESS_RUN_ID is required");
    process.exit(1);
  }
  const dataset = process.env.HARNESS_DATASET;
  if (!dataset) {
    console.error("HARNESS_DATASET is required");
    process.exit(1);
  }
  const queryApiKey = process.env.HONEYCOMB_QUERY_API_KEY ?? "";

  const repoDir = resolve(harnessRoot, "checkouts", app);
  const result = await evaluateAll(app, dataset, queryApiKey, runId, harnessRoot, repoDir);

  const outPath = resolve(harnessRoot, "tmp", `.eval-results.${app}.json`);
  writeFileSync(outPath, JSON.stringify(result));
  console.log(`[run-eval] wrote eval results → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
