import { appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { AgentMetrics } from "./instrumentation.js";
import type { EvaluationResults } from "./evaluation.js";
import type { WeaverResult } from "./weaver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_FILE = resolve(__dirname, "..", "runs.jsonl");

export interface RunRecord {
  timestamp: string;
  app: string;
  skill_branch: string;
  skill_sha: string;
  skill_commit: string;
  failed: boolean;
  failure_reason: string | null;
  agent: AgentMetrics;
  criteria?: EvaluationResults;
  // Full weaver live-check report (the weaver_live_check criterion is the headline).
  weaver?: WeaverResult;
}

export function recordRun(record: RunRecord): void {
  appendFileSync(RUNS_FILE, JSON.stringify(record) + "\n");
}

// `log` lets callers tee the summary into a run-scoped progress file as well as stdout;
// defaults to console.log for callers that only want the terminal.
export function printSummary(record: RunRecord, log: (line: string) => void = console.log): void {
  const { app, skill_branch, skill_sha, failed, failure_reason, agent, criteria, weaver } =
    record;

  log("\n" + "─".repeat(60));
  log(`Run: ${app}  skill: ${skill_branch} @ ${skill_sha}`);
  log(
    `Agent: ${agent.tool_uses} tool calls · ${agent.total_tokens} tokens · ${(agent.duration_ms / 1000).toFixed(1)}s`
  );

  if (failed) {
    log(`Result: ❌ FAILED — ${failure_reason?.split("\n")[0]}`);
  } else if (criteria) {
    const results = Object.entries(criteria);
    const passed = results.filter(([, v]) => v.pass).length;
    log(`Result: ${passed}/${results.length} criteria passed`);
    for (const [key, val] of results) {
      const icon = val.pass ? "✅" : "❌";
      const detail = val.value !== undefined ? ` (${JSON.stringify(val.value)})` : "";
      log(`  ${icon} ${key}${detail}`);
    }
    if (weaver && !weaver.skipped) {
      log(
        `  weaver: ${weaver.violations} violations · ${weaver.improvements} improvements · ` +
          `${weaver.total_entities} entities · registry: ${weaver.registry}`
      );
    } else if (weaver?.skipped) {
      log(`  weaver: skipped (${weaver.reason})`);
    }
  }
  log("─".repeat(60));
}
