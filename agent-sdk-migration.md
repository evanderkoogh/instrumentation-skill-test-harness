# Plan: Migrate Harness Orchestration to Agent SDK

## Context

The current harness runs the instrumentation workflow interactively — a human manually
sequences each step, spawns the instrumentation agent via the Claude Code `Agent` tool,
patches any agent mistakes, runs Honeycomb queries, and records results. This has been
useful for developing the skill but has three problems:

1. **No per-agent telemetry**: The instrumentation subagent's traces can't route to a
   separate Honeycomb dataset (Claude Code doesn't pass OTEL env vars to child processes).
   The Agent SDK supports per-call OTEL config.
2. **Not automatable**: Multiple iterations overnight, or across skill branches, require
   a human at each step.
3. **Manual patching masks failures**: When the agent produces broken code (e.g. missing
   `.sync_engine`), the human patches and continues — hiding a real skill quality failure.
   The SDK version must treat any startup failure as a hard failed run, not a manual-fix
   opportunity.

The migration replaces human orchestration with a TypeScript script using the Claude Code
Agent SDK. The bash scripts (`harness.sh`) stay unchanged.

---

## Resolved Decisions

- **Language**: TypeScript (Node.js 22, already in `.tool-versions`)
- **Evaluation**: Direct Honeycomb REST API calls — no second agent
- **Scope**: Single-run first; loop mode as a second milestone
- **Failure policy**: If `harness.sh <app> start` exits non-zero, the run is recorded as
  FAILED and stops. No patching, no retry.

---

## Target Architecture

```
run.ts <app> [--skill-branch BRANCH]
│
├── harness("reset", "--purge")
├── harness("build")
├── harness("bootstrap")          # no-op for apps that don't need it
├── harness("instrument")         # writes .instrument-prompt.md + .skill-version
│
├── SDK query() ── instrumentation agent
│   ├── OTEL → "{app}-instrumentation" dataset in Honeycomb
│   ├── cwd = apps/<app>/DemoSite
│   └── captures: duration_ms, tool_uses, input_tokens, output_tokens
│
├── harness("start")              # EXIT 1 → record FAILED, stop
├── harness("traffic")
├── sleep(15_000)                 # allow spans to flush
│
├── Honeycomb REST API ── evaluation
│   ├── common criteria from EVALUATION.md
│   └── app-specific criteria from apps/<app>/EVALUATION.md
│
└── append to runs.jsonl
```

---

## Implementation Steps

### Step 1 — Project setup

```bash
npm init -y
npm install @anthropic-ai/claude-code dotenv
npm install -D typescript @types/node tsx
npx tsc --init
```

Load env from `.env` (already has `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_ENDPOINT`).

Run with: `npx tsx run.ts beaverhabits`

### Step 2 — Subprocess wrapper

```typescript
import { execFileSync, spawnSync } from "child_process";
import { resolve } from "path";

const HARNESS = resolve(__dirname, "harness.sh");

class HarnessError extends Error {}
class StartupFailure extends Error {}

function harness(app: string, ...args: string[]): string {
  const result = spawnSync(HARNESS, [app, ...args], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new HarnessError(
      `harness.sh ${app} ${args.join(" ")} failed:\n${result.stderr}`
    );
  }
  return result.stdout;
}

function harnessStart(app: string): void {
  const result = spawnSync(HARNESS, [app, "start"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new StartupFailure(result.stderr);
  }
}
```

### Step 3 — Instrumentation agent

```typescript
import { query, type ClaudeCodeOptions } from "@anthropic-ai/claude-code";
import { readFileSync } from "fs";

interface AgentMetrics {
  duration_ms: number;
  tool_uses: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

async function runInstrumentation(
  app: string,
  apiKey: string
): Promise<AgentMetrics> {
  const prompt = readFileSync(".instrument-prompt.md", "utf8");
  const repoDir = resolve(`apps/${app}/DemoSite`);

  const start = Date.now();
  let toolUses = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of query({
    prompt,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      cwd: repoDir,
      maxTurns: 100,               // beaverhabits peaks at 37, broadleaf at 61
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
        OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${apiKey}`,
        OTEL_SERVICE_NAME: `${app}-instrumentation`,
      },
    } satisfies ClaudeCodeOptions,
  })) {
    // log tool calls for visibility, accumulate usage
    handleEvent(event, { onToolUse: () => toolUses++ });
    if (event.type === "result") {
      inputTokens = event.usage?.input_tokens ?? 0;
      outputTokens = event.usage?.output_tokens ?? 0;
    }
  }

  return {
    duration_ms: Date.now() - start,
    tool_uses: toolUses,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}
```

### Step 4 — Evaluation via Honeycomb REST API

```typescript
interface QuerySpec {
  calculations: Array<{ op: string; column?: string }>;
  filters?: Array<{ column: string; op: string; value?: unknown }>;
  breakdowns?: string[];
  time_range?: string;
}

async function runHoneycombQuery(
  dataset: string,
  querySpec: QuerySpec,
  apiKey: string,
  env = "test"
): Promise<Record<string, unknown>[]> {
  const base = "https://api.honeycomb.io/1";
  const headers = { "X-Honeycomb-Team": apiKey };

  const createRes = await fetch(`${base}/queries/${dataset}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { ...querySpec, time_range: "15m" }, limit: 100 }),
  });
  const { id: queryId } = (await createRes.json()) as { id: string };

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const res = await fetch(`${base}/query_results/${queryId}`, {
      headers: { ...headers, "X-Honeycomb-Environment": env },
    });
    const data = (await res.json()) as { complete: boolean; data?: { results: unknown[] } };
    if (data.complete) return (data.data?.results ?? []) as Record<string, unknown>[];
  }
  throw new Error("Honeycomb query timed out");
}
```

Common criteria (from root `EVALUATION.md`):
- `checkSpansArriving` — COUNT > 0
- `checkHttpRoutes` — server spans with `http.route` exists, not just `/*`
- `checkDbSpans` — `db.system` exists
- `checkSkillVersion` — `service.instrumentation_skill.branch` exists
- `checkRootlessTraces` — COUNT with `none.trace.parent_id does-not-exist` + `any.trace.parent_id exists` == 0
- `checkNoExplosion` — top span name count < threshold

### Step 5 — Failure handling and main flow

```typescript
async function run(app: string): Promise<void> {
  harness(app, "reset", "--purge");
  harness(app, "build");
  harness(app, "bootstrap");      // no-op if not needed
  harness(app, "instrument");

  const agentMetrics = await runInstrumentation(app, apiKey);

  try {
    harnessStart(app);
  } catch (err) {
    if (err instanceof StartupFailure) {
      recordRun(app, { agentMetrics, failed: true, failureReason: err.message });
      return;
    }
    throw err;
  }

  harness(app, "traffic");
  await sleep(15_000);

  const criteria = await evaluate(app, apiKey);
  recordRun(app, { agentMetrics, criteria });

  harness(app, "stop");
}
```

### Step 6 — runs.jsonl record

```json
{
  "timestamp": "2026-06-10T09:00:00Z",
  "app": "beaverhabits",
  "skill_branch": "python-misc",
  "skill_sha": "56b06c1",
  "skill_commit": "Warn that server_request_hook silently fails for NiceGUI http.route",
  "failed": false,
  "failure_reason": null,
  "agent": {
    "duration_ms": 143496,
    "tool_uses": 30,
    "input_tokens": 58000,
    "output_tokens": 11340,
    "total_tokens": 69340
  },
  "criteria": {
    "spans_arriving":   { "pass": true,  "value": 33 },
    "http_routes":      { "pass": false },
    "db_spans":         { "pass": true,  "value": "sqlite" },
    "skill_version":    { "pass": true },
    "rootless_traces":  { "pass": true,  "value": 0 },
    "no_explosion":     { "pass": true,  "top_count": 19 }
  }
}
```

Failed runs include `"failed": true, "failure_reason": "..."` and no `criteria` key.

---

## File Structure

```
run.ts                        # Entry point: npx tsx run.ts <app>
src/
  harness.ts                  # subprocess wrappers, HarnessError, StartupFailure
  instrumentation.ts          # SDK agent invocation + event handling + metric capture
  evaluation.ts               # Honeycomb REST API helpers + criterion check functions
  metrics.ts                  # runs.jsonl append + stdout summary
runs.jsonl                    # Append-only run history (gitignored)
package.json
tsconfig.json
```

---

## What the Bash Scripts Don't Change

`harness.sh` stays identical. The SDK calls it as subprocesses. The `instrument` command
still generates `.instrument-prompt.md` and writes `.skill-version` — the TypeScript
script reads those files rather than generating them itself.

The pre-start checks in `apps/<app>/config.sh` (e.g. async SQLAlchemy detection) run as
part of `harness.sh <app> start` — their exit codes propagate to `StartupFailure`.

---

## Verification

1. `npx tsx run.ts beaverhabits` completes without human input
2. Running with a broken agent (missing `.sync_engine`) records a FAILED run in
   `runs.jsonl` and stops — no patching
3. Instrumentation agent spans appear in `beaverhabits-instrumentation` dataset in Honeycomb
4. Two consecutive runs produce independent records in `runs.jsonl`
5. `npx tsx run.ts broadleaf` works with the same script (bootstrap handled by harness)

---

## Out of Scope (future milestones)

- Loop mode: `npx tsx run.ts beaverhabits --runs 5`
- CI integration: scheduled runs posting results to Slack/Linear
- Skill branch sweep: run same app against multiple skill commits and diff results
