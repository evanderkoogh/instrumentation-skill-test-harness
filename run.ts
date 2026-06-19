import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readdirSync } from "fs";
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
import { evaluate } from "./src/evaluation.js";
import { recordRun, printSummary } from "./src/metrics.js";
import { initTracing, shutdownTracing, getTracer } from "./src/otel.js";
import { SpanStatusCode } from "@opentelemetry/api";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

// --- Arg parsing ---
// Usage: npx tsx run.ts <app...|all> [--parallel] [--model <model-id>]
// One app  → run inline (full in-process tracing).
// Many apps → spawn one child process per app, sequential or --parallel.
const apps: string[] = [];
let parallel = false;
let modelArg: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--parallel") parallel = true;
  else if (a === "--model") modelArg = process.argv[++i];
  else apps.push(a);
}

if (apps.length === 0) {
  console.error("Usage: npx tsx run.ts <app...|all> [--parallel] [--model <model-id>]");
  process.exit(1);
}

// "all" expands to every app profile under apps/.
const appList = apps.includes("all")
  ? readdirSync(resolve(__dirname, "apps"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : apps;

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

async function runApp(app: string): Promise<void> {
  const tracer = getTracer();
  const { dataset } = readAppConfig(app);
  const timestamp = new Date().toISOString();

  console.log(`\n▶ Run: ${app}  dataset: ${dataset}${modelArg ? `  model: ${modelArg}` : ""}`);

  await tracer.startActiveSpan(`run`, async (rootSpan) => {
    rootSpan.setAttributes({ app, "run.timestamp": timestamp });
    if (modelArg) rootSpan.setAttribute("model.requested", modelArg);

    try {
      // --- Setup ---
      for (const step of ["download", "reset --purge", "build", "bootstrap", "instrument"] as const) {
        const [cmd, ...args] = step.split(" ");
        console.log(`→ ${step}`);
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

      const skill = readSkillVersion(app);
      console.log(`  skill: ${skill.branch} @ ${skill.sha}`);
      rootSpan.setAttributes({
        "skill.branch": skill.branch,
        "skill.sha": skill.sha,
        "skill.commit": skill.commit,
      });

      // --- Instrumentation agent ---
      console.log("→ running instrumentation agent");
      const agentMetrics = await tracer.startActiveSpan("instrumentation-agent", async (span) => {
        try {
          const metrics = await runInstrumentation(app, ingestKey, modelArg, skill);
          span.setAttributes({
            "agent.model": metrics.model,
            "agent.session_id": metrics.session_id,
            "agent.tool_uses": metrics.tool_uses,
            "agent.input_tokens": metrics.input_tokens,
            "agent.output_tokens": metrics.output_tokens,
            "agent.total_tokens": metrics.total_tokens,
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
      console.log(
        `  done: ${agentMetrics.tool_uses} tool calls · ${agentMetrics.total_tokens} tokens · ${(agentMetrics.duration_ms / 1000).toFixed(1)}s`
      );
      rootSpan.setAttributes({
        "agent.model": agentMetrics.model,
        "agent.session_id": agentMetrics.session_id,
        "agent.tool_uses": agentMetrics.tool_uses,
        "agent.total_tokens": agentMetrics.total_tokens,
      });

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
      harness(app, "stop");
      try {
        await tracer.startActiveSpan("start", async (span) => {
          try {
            harnessStart(app);
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
          printSummary(record);
          harness(app, "stop");
          return;
        }
        throw err;
      }

      // --- Traffic + flush ---
      console.log("→ traffic");
      await tracer.startActiveSpan("traffic", async (span) => {
        try {
          harness(app, "traffic");
        } finally {
          span.end();
        }
      });
      console.log("→ waiting 15s for spans to flush");
      await sleep(15_000);

      // --- Evaluate ---
      console.log("→ evaluating");
      const criteria = await tracer.startActiveSpan("evaluate", async (span) => {
        try {
          const results = await evaluate(dataset, queryApiKey);
          for (const [key, val] of Object.entries(results)) {
            span.setAttribute(`criterion.${key}.pass`, val.pass);
            if (val.value !== undefined) {
              span.setAttribute(`criterion.${key}.value`, JSON.stringify(val.value));
            }
          }
          return results;
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

      const record = { ...baseRecord, failed: false, failure_reason: null, criteria };
      recordRun(record);
      printSummary(record);

      harness(app, "stop");
    } catch (err) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
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
  return new Promise((res) => {
    const child = spawn("npx", args, { stdio: "inherit", cwd: __dirname });
    child.on("exit", (code) => res(code ?? 1));
  });
}

async function orchestrate(): Promise<void> {
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
