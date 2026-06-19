import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Written by harness.sh start_collector() when the weaver-capture pipeline is up.
interface WeaverState {
  adminPort: number;
  reportFile: string;
  registry: string;
}

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
export async function runWeaverLiveCheck(app: string): Promise<WeaverResult> {
  const stateFile = resolve(__dirname, "..", "tmp", `.harness.${app}.weaver.json`);
  if (!existsSync(stateFile)) {
    return { pass: false, skipped: true, reason: "weaver capture not enabled for this run" };
  }

  let state: WeaverState;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as WeaverState;
  } catch (err) {
    return { pass: false, skipped: true, reason: `unreadable weaver state: ${String(err)}` };
  }

  // Tell weaver to finalize: it writes reportFile and exits. Best-effort — the report may
  // already exist if weaver hit its inactivity timeout first.
  try {
    await fetch(`http://127.0.0.1:${state.adminPort}/stop`, { method: "POST" });
  } catch {
    // weaver may have already stopped; fall through to reading the report.
  }

  // Poll for the report to be written and fully parseable.
  let report: WeaverReport | null = null;
  for (let i = 0; i < 20; i++) {
    if (existsSync(state.reportFile)) {
      try {
        report = JSON.parse(readFileSync(state.reportFile, "utf8")) as WeaverReport;
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
      registry: state.registry,
    };
  }

  const stats = report.statistics ?? {};
  const levels = stats.advice_level_counts ?? {};
  const violations = levels["violation"] ?? 0;
  const improvements = levels["improvement"] ?? 0;
  const information = levels["information"] ?? 0;
  const totalEntities = stats.total_entities ?? 0;
  const registryCustom = state.registry !== "upstream-semconv";

  // Pass requires: the skill actually created a registry, telemetry reached weaver, and
  // the telemetry raised no violations against that registry. Improvements/information are
  // advisory and don't fail the run.
  const pass = registryCustom && totalEntities > 0 && violations === 0;

  return {
    pass,
    skipped: false,
    registry: state.registry,
    registry_custom: registryCustom,
    total_entities: totalEntities,
    total_advisories: stats.total_advisories ?? 0,
    violations,
    improvements,
    information,
    advice_type_counts: stats.advice_type_counts ?? {},
  };
}
