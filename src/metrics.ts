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

// Sub-cent costs are meaningful here (cache reads are cheap per token), so show
// 4 decimals below $1 and 2 above.
function formatUsd(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// `log` lets callers tee the summary into a run-scoped progress file as well as stdout;
// defaults to console.log for callers that only want the terminal.
export function printSummary(record: RunRecord, log: (line: string) => void = console.log): void {
  const { app, skill_branch, skill_sha, failed, failure_reason, agent, criteria, weaver } =
    record;

  log("\n" + "─".repeat(60));
  log(`Run: ${app}  skill: ${skill_branch} @ ${skill_sha}`);
  log(
    `Agent: ${agent.tool_uses} tool calls · ${agent.total_tokens} tokens · ` +
      `${formatUsd(agent.cost.total_usd)} · ${(agent.duration_ms / 1000).toFixed(1)}s`
  );
  // Token mix + where the money went. Cache reads usually dominate.
  log(
    `  tokens: ${agent.input_tokens} in · ${agent.output_tokens} out · ` +
      `${agent.cache_read_input_tokens} cache-read · ${agent.cache_creation_input_tokens} cache-write`
  );
  log(
    `  cost: ${formatUsd(agent.cost.total_usd)} ` +
      `(in ${formatUsd(agent.cost.input_usd)} · out ${formatUsd(agent.cost.output_usd)} · ` +
      `cache-read ${formatUsd(agent.cost.cache_read_usd)} · cache-write ${formatUsd(agent.cost.cache_write_usd)})`
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
