import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readdirSync, readFileSync, appendFileSync, mkdirSync, rmSync } from "fs";
import { spawn } from "node:child_process";
import {
  harness,
  harnessStart,
  readAppConfig,
  readSkillVersion,
  sleep,
  StartupFailure,
} from "./src/harness.js";
import { runInstrumentation } from "./src/instrumentation.js";
import { evaluate, type EvaluationResults } from "./src/evaluation.js";
import { runWeaverLiveCheck } from "./src/weaver.js";
import { evaluateEnvVarOutput } from "./src/envvars.js";
import { recordRun, printSummary } from "./src/metrics.js";
import { initTracing, shutdownTracing, getTracer } from "./src/otel.js";
import { SpanStatusCode } from "@opentelemetry/api";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

// --- Arg parsing ---
// Usage: npx tsx run.ts <app...|all> [--parallel] [--model <model-id>] [--skill-desc <text>]
// One app  → run inline (full in-process tracing).
// Many apps → spawn one child process per app, sequential or --parallel.
const apps: string[] = [];
let parallel = false;
let modelArg: string | undefined;
// Human label of intent for this run (e.g. "free-port weaver"). Recorded alongside the
// skill content hash so a run is identifiable even with uncommitted edits.
let skillDesc: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--parallel") parallel = true;
  else if (a === "--model") modelArg = process.argv[++i];
  else if (a === "--skill-desc") skillDesc = process.argv[++i];
  else apps.push(a);
}

// `kill`/`stop` subcommand: cleanly terminate active runs (and their app servers / collector /
// weaver) via tracked PID files — instead of hand-rolled pkill patterns that miss the children.
// `run.ts kill` with no targets stops every app.
const killMode = apps[0] === "kill" || apps[0] === "stop";
if (killMode) apps.shift();

if (!killMode && apps.length === 0) {
  console.error(
    "Usage: npx tsx run.ts <app...|all> [--parallel] [--model <model-id>] [--skill-desc <text>]\n" +
      "       npx tsx run.ts kill [app...|all]   # stop active run(s)"
  );
  process.exit(1);
}

const allApps = (): string[] =>
  readdirSync(resolve(__dirname, "apps"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

// "all" (or, in kill mode, no targets) expands to every app profile under apps/.
const appList =
  apps.includes("all") || (killMode && apps.length === 0) ? allApps() : apps;

// Ingest key — forwarded to the instrumentation agent for OTLP export
const ingestKey = (() => {
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  const match = headers.match(/x-honeycomb-team=([^,]+)/);
  return match?.[1] ?? "";
})();

// Query key — used by evaluation to read from Honeycomb REST API
// Must have "Query Data" permission (ingest keys are write-only)
const queryApiKey = process.env.HONEYCOMB_QUERY_API_KEY ?? "";

// Keys are only needed to RUN; the kill subcommand doesn't touch Honeycomb.
if (!killMode) {
  if (!ingestKey) {
    console.error("OTEL_EXPORTER_OTLP_HEADERS not set in .env");
    process.exit(1);
  }
  if (!queryApiKey) {
    console.error("HONEYCOMB_QUERY_API_KEY not set in .env (needs Query Data permission)");
    process.exit(1);
  }
}

// Per-app, run-scoped progress logger. Truncates tmp/run-progress.<app>.log at the
// start of every run so a `tail -f` only ever shows the CURRENT run for this app —
// unlike an append-only cross-run log, which mixes stale entries from earlier runs.
// Mirrors each line to stdout (inherited by the parent in parallel mode) and the file.
function makeProgressLog(app: string): (line: string) => void {
  const file = resolve(__dirname, "tmp", `run-progress.${app}.log`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# run-progress ${app} — ${new Date().toISOString()}\n`);
  return (line: string) => {
    console.log(line);
    appendFileSync(file, line + "\n");
  };
}

// --- Run-process tracking ---
// Each in-flight app run records its PID here so we can detect a run that's already in progress
// (and refuse to start a second one that would collide on ports/logs) and stop it cleanly later —
// rather than guessing pkill patterns that miss the children.
const runPidFile = (app: string) => resolve(__dirname, "tmp", `.run.${app}.pid`);

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, sends nothing
    return true;
  } catch {
    return false; // ESRCH (gone) or EPERM (alive but not ours — treat as not-ours-to-manage)
  }
}

// The PID of an in-flight run for this app, or null. A stale pid file (process gone) reads as null,
// so a crashed run never blocks a fresh one.
function activeRunPid(app: string): number | null {
  try {
    const pid = Number(readFileSync(runPidFile(app), "utf8").trim());
    return pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Stop active run(s): SIGTERM (then SIGKILL) the run process, and always run `harness stop` to
// clear the app server / collector / weaver it may have spawned (those hold ports).
async function killRuns(targets: string[]): Promise<void> {
  for (const app of targets) {
    const pid = activeRunPid(app);
    if (pid) {
      console.log(`Stopping run for ${app} (PID ${pid})…`);
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
      if (pidAlive(pid)) {
        console.log(`  PID ${pid} still alive after 5s — SIGKILL.`);
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    } else {
      console.log(`No active run process for ${app}.`);
    }
    rmSync(runPidFile(app), { force: true });
    try { harness(app, "stop"); } catch { /* best-effort cleanup of servers/collector/weaver */ }
  }
  console.log("Done.");
}

async function runApp(app: string): Promise<void> {
  // Refuse to start if a run for this app is already in progress — a second one would collide on
  // ports and clobber the progress log. (Checked before makeProgressLog so we don't truncate the
  // active run's log.) Stale pid files (dead process) don't block.
  const existing = activeRunPid(app);
  if (existing) {
    console.error(
      `✋ A run for ${app} is already in progress (PID ${existing}). ` +
        `Stop it first:  npx tsx run.ts kill ${app}`
    );
    throw new Error(`run already active for ${app} (PID ${existing})`);
  }
  mkdirSync(resolve(__dirname, "tmp"), { recursive: true });
  writeFileSync(runPidFile(app), String(process.pid));
  process.once("exit", () => {
    try { rmSync(runPidFile(app), { force: true }); } catch {}
  });

  const tracer = getTracer();
  const { dataset } = readAppConfig(app);
  const timestamp = new Date().toISOString();
  // Unique per app-run. The collector stamps it on every span as harness.run_id, and the
  // evaluation filters its Honeycomb queries to it — so a run is only ever scored against
  // its own telemetry (the dataset is shared and its column schema persists across runs).
  const runId = `${app}-${timestamp}`;
  const log = makeProgressLog(app);

  log(`\n▶ Run: ${app}  dataset: ${dataset}${modelArg ? `  model: ${modelArg}` : ""}`);

  await tracer.startActiveSpan(`run`, async (rootSpan) => {
    rootSpan.setAttributes({ app, "run.timestamp": timestamp });
    if (modelArg) rootSpan.setAttribute("model.requested", modelArg);

    try {
      // --- Setup ---
      for (const step of ["download", "download-tools", "reset --purge", "build", "bootstrap", "instrument"] as const) {
        const [cmd, ...args] = step.split(" ");
        log(`→ ${step}`);
        await tracer.startActiveSpan(step, async (span) => {
          try {
            harness(app, cmd, ...args);
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
            throw err;
          } finally {
            span.end();
          }
        });
      }

      const skill = { ...readSkillVersion(app), description: skillDesc };
      const shaPart = `${skill.sha}${skill.uncommitted ? "+uncommitted" : ""}`;
      log(
        `  skill: ${skill.branch} @ ${shaPart} [${skill.contentHash}]` +
          (skill.description ? ` — ${skill.description}` : "")
      );
      rootSpan.setAttributes({
        "skill.branch": skill.branch,
        "skill.sha": skill.sha,
        "skill.commit": skill.commit,
        "skill.content_hash": skill.contentHash,
        "skill.uncommitted": skill.uncommitted,
        ...(skill.description ? { "skill.description": skill.description } : {}),
      });

      // --- Instrumentation agent ---
      log("→ running instrumentation agent");
      const agentMetrics = await tracer.startActiveSpan("instrumentation-agent", async (span) => {
        try {
          const metrics = await runInstrumentation(app, ingestKey, modelArg, skill);
          span.setAttributes({
            "agent.model": metrics.model,
            "agent.session_id": metrics.session_id,
            "agent.tool_uses": metrics.tool_uses,
            "agent.input_tokens": metrics.input_tokens,
            "agent.output_tokens": metrics.output_tokens,
            "agent.cache_read_input_tokens": metrics.cache_read_input_tokens,
            "agent.cache_creation_input_tokens": metrics.cache_creation_input_tokens,
            "agent.total_tokens": metrics.total_tokens,
            "agent.cost_usd": metrics.cost.total_usd,
            "agent.duration_ms": metrics.duration_ms,
          });
          return metrics;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally {
          span.end();
        }
      });
      const costStr =
        agentMetrics.cost.total_usd < 1
          ? `$${agentMetrics.cost.total_usd.toFixed(4)}`
          : `$${agentMetrics.cost.total_usd.toFixed(2)}`;
      log(
        `  done: ${agentMetrics.tool_uses} tool calls · ${agentMetrics.total_tokens} tokens · ${costStr} · ${(agentMetrics.duration_ms / 1000).toFixed(1)}s`
      );
      rootSpan.setAttributes({
        "agent.model": agentMetrics.model,
        "agent.session_id": agentMetrics.session_id,
        "agent.tool_uses": agentMetrics.tool_uses,
        "agent.total_tokens": agentMetrics.total_tokens,
        "agent.cost_usd": agentMetrics.cost.total_usd,
      });

      // Re-write .skill-version: the agent may have overwritten it with its own content.
      // Preserve the content hash + uncommitted flag the instrument step computed.
      const versionPath = resolve(__dirname, "checkouts", app, ".skill-version");
      writeFileSync(
        versionPath,
        `SKILL_BRANCH=${skill.branch}\nSKILL_SHA=${skill.sha}\nSKILL_COMMIT_MSG="${skill.commit}"\n` +
          `SKILL_CONTENT_HASH=${skill.contentHash}\nSKILL_UNCOMMITTED=${skill.uncommitted}\n`
      );

      const baseRecord = {
        timestamp,
        app,
        model: agentMetrics.model,
        skill_branch: skill.branch,
        skill_sha: skill.sha,
        skill_commit: skill.commit,
        skill_content_hash: skill.contentHash,
        skill_uncommitted: skill.uncommitted,
        skill_description: skill.description ?? null,
        agent: agentMetrics,
      };

      // --- Start ---
      log("→ start");
      harness(app, "stop");
      try {
        await tracer.startActiveSpan("start", async (span) => {
          try {
            harnessStart(app, runId);
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
            throw err;
          } finally {
            span.end();
          }
        });
      } catch (err) {
        if (err instanceof StartupFailure) {
          rootSpan.setAttributes({ "run.failed": true, "run.failure_reason": err.reason });
          rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "startup failed" });
          const record = { ...baseRecord, failed: true, failure_reason: err.reason, criteria: undefined };
          recordRun(record);
          printSummary(record, log);
          harness(app, "stop");
          return;
        }
        throw err;
      }

      // --- Traffic + flush ---
      log("→ traffic");
      await tracer.startActiveSpan("traffic", async (span) => {
        try {
          harness(app, "traffic");
        } finally {
          span.end();
        }
      });
      log("→ waiting 15s for spans to flush");
      await sleep(15_000);

      // --- Evaluate ---
      // Honeycomb query criteria + the local weaver live-check verdict. Both run after the
      // flush wait: evaluate() reads Honeycomb; runWeaverLiveCheck() finalizes the weaver
      // OTLP receiver (POST /stop) and parses its report. They're independent.
      log("→ evaluating");
      const { criteria, weaver } = await tracer.startActiveSpan("evaluate", async (span) => {
        try {
          const [hc, weaverResult] = await Promise.all([
            evaluate(dataset, queryApiKey, runId),
            runWeaverLiveCheck(app),
          ]);
          const merged: EvaluationResults = {
            ...hc,
            weaver_live_check: {
              pass: weaverResult.pass,
              value: weaverResult.skipped
                ? `skipped: ${weaverResult.reason}`
                : `${weaverResult.violations} violations, ${weaverResult.improvements} improvements (registry: ${weaverResult.registry})`,
            },
            env_var_output: evaluateEnvVarOutput(
              app,
              resolve(__dirname, "checkouts", app),
              __dirname
            ),
          };
          for (const [key, val] of Object.entries(merged)) {
            span.setAttribute(`criterion.${key}.pass`, val.pass);
            if (val.value !== undefined) {
              span.setAttribute(`criterion.${key}.value`, JSON.stringify(val.value));
            }
          }
          if (!weaverResult.skipped) {
            span.setAttributes({
              "weaver.violations": weaverResult.violations ?? 0,
              "weaver.improvements": weaverResult.improvements ?? 0,
              "weaver.total_entities": weaverResult.total_entities ?? 0,
              "weaver.registry": weaverResult.registry ?? "",
            });
          }
          return { criteria: merged, weaver: weaverResult };
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally {
          span.end();
        }
      });

      const criteriaEntries = Object.entries(criteria);
      const passedCount = criteriaEntries.filter(([, v]) => v.pass).length;
      rootSpan.setAttributes({
        "run.failed": false,
        "run.criteria_passed": passedCount,
        "run.criteria_total": criteriaEntries.length,
      });
      for (const [key, val] of criteriaEntries) {
        rootSpan.setAttribute(`criterion.${key}.pass`, val.pass);
      }

      const record = { ...baseRecord, failed: false, failure_reason: null, criteria, weaver };
      recordRun(record);
      printSummary(record, log);

      harness(app, "stop");
    } catch (err) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      // Tear down the app's servers + capture collector so a mid-run failure (e.g. an
      // evaluation/query error after the app is already started) doesn't leak processes that
      // keep holding this app's ports and break the next run's bootstrap/start. Best-effort:
      // a cleanup failure must never mask the original error.
      try {
        harness(app, "stop");
      } catch {
        // ignore — propagate the original failure below
      }
      throw err;
    } finally {
      rootSpan.end();
    }
  });
}

// Spawn `npx tsx run.ts <app>` as a child so each app run is fully isolated
// (own process, own OTel tracing, own dataset). Resolves to the child exit code.
function spawnChild(app: string): Promise<number> {
  const args = ["tsx", resolve(__dirname, "run.ts"), app];
  if (modelArg) args.push("--model", modelArg);
  if (skillDesc) args.push("--skill-desc", skillDesc);
  return new Promise((res) => {
    const child = spawn("npx", args, { stdio: "inherit", cwd: __dirname });
    child.on("exit", (code) => res(code ?? 1));
  });
}

async function orchestrate(): Promise<void> {
  // `kill`/`stop` subcommand: stop active runs and exit (no tracing, no Honeycomb).
  if (killMode) {
    await killRuns(appList);
    return;
  }

  // Single app → run inline so the run spans export from this process.
  if (appList.length === 1) {
    initTracing();
    try {
      await runApp(appList[0]);
    } finally {
      await shutdownTracing();
    }
    return;
  }

  // Multiple apps → fan out to child processes.
  console.log(
    `\n▶ Running ${appList.length} apps ${parallel ? "in parallel" : "sequentially"}: ${appList.join(", ")}`
  );
  const exitCodes: Record<string, number> = {};
  if (parallel) {
    await Promise.all(
      appList.map((a) => spawnChild(a).then((code) => { exitCodes[a] = code; }))
    );
  } else {
    for (const a of appList) exitCodes[a] = await spawnChild(a);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Multi-app run complete:");
  for (const a of appList) {
    console.log(`  ${exitCodes[a] === 0 ? "✅" : "❌"} ${a} (exit ${exitCodes[a]})`);
  }
  console.log("=".repeat(60));
  if (Object.values(exitCodes).some((c) => c !== 0)) process.exit(1);
}

orchestrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
