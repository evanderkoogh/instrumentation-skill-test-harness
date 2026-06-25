import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { CriterionResult } from "./evaluation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Subset of `weaver registry live-check --format json` report we care about.
interface WeaverReport {
  statistics?: {
    total_entities?: number;
    total_advisories?: number;
    advice_level_counts?: Record<string, number>;
    advice_type_counts?: Record<string, number>;
  };
}

export interface WeaverResult {
  pass: boolean;
  skipped: boolean;
  reason?: string;
  registry?: string;
  registry_custom?: boolean;
  total_entities?: number;
  total_advisories?: number;
  violations?: number;
  improvements?: number;
  information?: number;
  advice_type_counts?: Record<string, number>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Finalize the per-run weaver live-check (POST its admin /stop, which makes it write the
// report and exit) and parse the resulting report. weaver ran as an OTLP receiver during
// traffic, fed by the fan-out collector; here we just collect its verdict.
//
// Container-only: the in-container lifecycle (docker/lifecycle.sh) starts the weaver live-check
// receiver in THIS same container and passes its admin port + the registry it used via env
// (HARNESS_WEAVER_ADMIN_PORT / HARNESS_WEAVER_REGISTRY) — no host state file. If those aren't set,
// weaver capture didn't come up, so the criterion is skipped.
export async function runWeaverLiveCheck(app: string): Promise<WeaverResult> {
  const adminPort = process.env.HARNESS_WEAVER_ADMIN_PORT;
  const registry = process.env.HARNESS_WEAVER_REGISTRY;
  if (!adminPort || !registry) {
    return { pass: false, skipped: true, reason: "weaver capture not enabled for this run" };
  }
  // weaver writes its report under logs/<app>/weaver-report/ (lifecycle.sh --output), in this same
  // harness layout — derive the path rather than passing it through.
  const reportFile = resolve(__dirname, "..", "logs", app, "weaver-report", "live_check.json");

  // Tell weaver to finalize: it writes reportFile and exits. Best-effort — the report may
  // already exist if weaver hit its inactivity timeout first. Admin is localhost (same netns).
  try {
    await fetch(`http://127.0.0.1:${adminPort}/stop`, { method: "POST" });
  } catch {
    // weaver may have already stopped; fall through to reading the report.
  }

  // Poll for the report to be written and fully parseable.
  let report: WeaverReport | null = null;
  for (let i = 0; i < 20; i++) {
    if (existsSync(reportFile)) {
      try {
        report = JSON.parse(readFileSync(reportFile, "utf8")) as WeaverReport;
        break;
      } catch {
        // partial write — wait and retry
      }
    }
    await sleep(1000);
  }

  if (!report) {
    return {
      pass: false,
      skipped: true,
      reason: "weaver report not produced",
      registry,
    };
  }

  const stats = report.statistics ?? {};
  const levels = stats.advice_level_counts ?? {};
  const violations = levels["violation"] ?? 0;
  const improvements = levels["improvement"] ?? 0;
  const information = levels["information"] ?? 0;
  const totalEntities = stats.total_entities ?? 0;
  const registryCustom = registry !== "upstream-semconv";

  // Pass requires: the skill actually created a registry, telemetry reached weaver, and
  // the telemetry raised no violations against that registry. Improvements/information are
  // advisory and don't fail the run.
  const pass = registryCustom && totalEntities > 0 && violations === 0;

  return {
    pass,
    skipped: false,
    registry,
    registry_custom: registryCustom,
    total_entities: totalEntities,
    total_advisories: stats.total_advisories ?? 0,
    violations,
    improvements,
    information,
    advice_type_counts: stats.advice_type_counts ?? {},
  };
}

// Render a WeaverResult as the `weaver_live_check` criterion (pass + human-readable value). Shared by
// the host path (run.ts) and the containerized path (run-eval.ts) so both produce identical criteria.
export function weaverCriterion(w: WeaverResult): CriterionResult {
  return {
    pass: w.pass,
    value: w.skipped
      ? `skipped: ${w.reason}`
      : `${w.violations} violations, ${w.improvements} improvements (registry: ${w.registry})`,
  };
}
