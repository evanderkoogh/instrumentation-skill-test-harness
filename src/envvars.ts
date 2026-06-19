import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { resolve } from "path";
import type { CriterionResult } from "./evaluation.js";

// env_var_output criterion.
//
// The skill instructs the agent to communicate the required-env-var contract to the user
// (a copy-pasteable export block in its final summary). This checks that the agent actually
// did so. The agent's final message is captured by runInstrumentation into
// tmp/agent-output.<app>.txt.
//
// Pass rules:
//   - The output must always name OTEL_EXPORTER_OTLP_ENDPOINT (the user has to point the
//     exporter somewhere; the harness injects it here, but a real deployment won't).
//   - OTEL_SEMCONV_STABILITY_OPT_IN must also be named UNLESS the agent set it as a real
//     env var in a committed launch script in the checkout (start script, Dockerfile,
//     Procfile, …). Setting it from application code does NOT count — instrumentation reads
//     the var once at init, so in-code mutation is unreliable; in that case the user still
//     has to set it at launch, so the agent must tell them.

const ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OPT_IN = "OTEL_SEMCONV_STABILITY_OPT_IN";

// Launch/config files where setting an env var actually takes effect before the process
// starts. Source files (.py/.go/.java/…) are intentionally excluded.
const LAUNCH_GLOBS = [
  "*.sh",
  "Dockerfile*",
  "*.dockerfile",
  "Procfile",
  ".env*",
  "*.env",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "*.bat",
  "*.ps1",
];

// True if the opt-in is set (`OTEL_SEMCONV_STABILITY_OPT_IN=…`) in a committed launch script.
function optInSetInLaunchScript(repoDir: string): boolean {
  try {
    const args = ["-rlIE", `${OPT_IN}=`];
    for (const g of LAUNCH_GLOBS) args.push(`--include=${g}`);
    args.push(repoDir);
    const out = execFileSync("grep", args, { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    // grep exits non-zero when there are no matches.
    return false;
  }
}

export function evaluateEnvVarOutput(
  app: string,
  repoDir: string,
  harnessRoot: string
): CriterionResult {
  const outputPath = resolve(harnessRoot, "tmp", `agent-output.${app}.txt`);
  if (!existsSync(outputPath)) {
    return { pass: false, value: "no agent output captured" };
  }
  const text = readFileSync(outputPath, "utf8");

  const hasEndpoint = text.includes(ENDPOINT);
  const optInInScript = optInSetInLaunchScript(repoDir);
  const hasOptInOutput = text.includes(OPT_IN);

  const missing: string[] = [];
  if (!hasEndpoint) missing.push(ENDPOINT);
  if (!optInInScript && !hasOptInOutput) {
    missing.push(`${OPT_IN} (not set in a launch script, so it must be communicated)`);
  }

  if (missing.length === 0) {
    return {
      pass: true,
      value: optInInScript
        ? `${ENDPOINT} communicated; ${OPT_IN} set in launch script`
        : `${ENDPOINT} + ${OPT_IN} communicated`,
    };
  }
  return { pass: false, value: `missing from agent output: ${missing.join(", ")}` };
}
