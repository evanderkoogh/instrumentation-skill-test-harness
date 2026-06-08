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

The migration replaces human orchestration with a Python script using the Claude Code
Agent SDK. The bash scripts (`harness.sh`) stay unchanged.

---

## Resolved Decisions

- **Language**: Python. Subprocess calls, httpx for Honeycomb API, uv for deps.
- **Evaluation**: Direct Honeycomb REST API calls — no second agent.
- **Scope**: Single-run first; loop mode as a second milestone.
- **Failure policy**: If `harness.sh <app> start` exits non-zero, the run is recorded as
  FAILED and stops. No patching, no retry.

---

## Target Architecture

```
run.py <app> [--skill-branch BRANCH]
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
├── sleep(15)                     # allow spans to flush
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
uv init run
uv add claude-code-sdk httpx python-dotenv
```

Load env from `.env` (already has `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_ENDPOINT`).

### Step 2 — Subprocess wrapper

```python
import subprocess, sys
from pathlib import Path

HARNESS = Path(__file__).parent / "harness.sh"

def harness(app: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        [str(HARNESS), app, *args],
        capture_output=True, text=True
    )
    if check and result.returncode != 0:
        raise HarnessError(f"harness.sh {app} {args} failed:\n{result.stderr}")
    return result

class HarnessError(Exception):
    pass

class StartupFailure(Exception):
    """Raised when start exits non-zero — signals a failed instrumentation run."""
    pass
```

For `start`, use `check=False` and inspect returncode explicitly:

```python
result = harness(app, "start", check=False)
if result.returncode != 0:
    raise StartupFailure(result.stderr)
```

### Step 3 — Instrumentation agent

```python
from claude_code_sdk import query, ClaudeCodeOptions
import time

async def run_instrumentation(app: str, api_key: str) -> dict:
    prompt = (Path(".instrument-prompt.md")).read_text()
    repo_dir = Path(f"apps/{app}/DemoSite")

    start = time.monotonic()
    tool_uses = 0
    input_tokens = output_tokens = 0

    async for event in query(
        prompt=prompt,
        options=ClaudeCodeOptions(
            allowed_tools=["Read", "Write", "Edit", "Bash"],
            cwd=str(repo_dir),
            max_turns=100,          # beaverhabits runs used up to 37, broadleaf up to 61
            env={
                "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
                "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
                "OTEL_TRACES_EXPORTER": "otlp",
                "OTEL_EXPORTER_OTLP_ENDPOINT": "https://api.honeycomb.io",
                "OTEL_EXPORTER_OTLP_HEADERS": f"x-honeycomb-team={api_key}",
                "OTEL_SERVICE_NAME": f"{app}-instrumentation",
            },
        )
    ):
        # print tool calls to stdout for visibility
        handle_event(event)
        # accumulate usage from events

    return {
        "duration_ms": int((time.monotonic() - start) * 1000),
        "tool_uses": tool_uses,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }
```

### Step 4 — Evaluation via Honeycomb REST API

```python
import httpx, time

def run_honeycomb_query(dataset: str, query_spec: dict, api_key: str,
                         env: str = "test", time_range: str = "15m") -> list[dict]:
    base = "https://api.honeycomb.io/1"
    headers = {"X-Honeycomb-Team": api_key}

    # Create query
    r = httpx.post(f"{base}/queries/{dataset}", headers=headers,
                   json={"query": {**query_spec, "time_range": time_range},
                         "limit": 100})
    r.raise_for_status()
    query_id = r.json()["id"]

    # Poll for results
    for _ in range(20):
        r = httpx.get(f"{base}/query_results/{query_id}",
                      headers={**headers, "X-Honeycomb-Environment": env})
        r.raise_for_status()
        data = r.json()
        if data.get("complete"):
            return data.get("data", {}).get("results", [])
        time.sleep(1)

    raise TimeoutError("Honeycomb query timed out")
```

App-specific dataset names come from `apps/<app>/config.sh` (e.g. `OTEL_SERVICE_NAME`).

Common criteria (from root `EVALUATION.md`):
- `check_spans_arriving` — COUNT > 0
- `check_http_routes` — server spans with `http.route` exists, not just `/*`
- `check_db_spans` — `db.system` exists
- `check_skill_version` — `service.instrumentation_skill.branch` exists
- `check_rootless_traces` — COUNT with `none.trace.parent_id does-not-exist` + `any.trace.parent_id exists` == 0
- `check_no_explosion` — top span name count < threshold

App-specific criteria loaded from `apps/<app>/EVALUATION.md` (parsed or hardcoded per app).

### Step 5 — Failure handling

```python
async def run(app: str):
    harness(app, "reset", "--purge")
    harness(app, "build")
    harness(app, "bootstrap")      # no-op if not needed
    harness(app, "instrument")

    agent_metrics = await run_instrumentation(app, api_key)

    try:
        harness(app, "start", check=False)  # raises StartupFailure on exit 1
    except StartupFailure as e:
        record_run(app, agent_metrics, failed=True, failure_reason=str(e))
        return

    harness(app, "traffic")
    time.sleep(15)

    criteria = evaluate(app, api_key)
    record_run(app, agent_metrics, criteria=criteria)

    harness(app, "stop")
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
run.py                        # Entry point: python run.py <app>
lib/
  harness.py                  # subprocess wrappers, HarnessError, StartupFailure
  instrumentation.py          # SDK agent invocation + event handling + metric capture
  evaluation.py               # Honeycomb REST API helpers + criterion check functions
  metrics.py                  # runs.jsonl append + stdout summary
runs.jsonl                    # Append-only run history (gitignored)
requirements.txt              # or pyproject.toml: claude-code-sdk, httpx, python-dotenv
```

---

## What the Bash Scripts Don't Change

`harness.sh` stays identical. The SDK calls it as subprocesses. The `instrument` command
still generates `.instrument-prompt.md` and writes `.skill-version` — the SDK reads
those files rather than generating them itself.

The pre-start checks in `apps/<app>/config.sh` (e.g. async SQLAlchemy detection) run as
part of `harness.sh <app> start` — their exit codes propagate to `StartupFailure`.

---

## Verification

1. `python run.py beaverhabits` completes without human input
2. `python run.py beaverhabits` with a broken agent (missing `.sync_engine`) records a
   FAILED run in `runs.jsonl` and stops — no patching
3. Instrumentation agent spans appear in `beaverhabits-instrumentation` dataset in Honeycomb
4. Two consecutive runs produce independent records in `runs.jsonl`
5. `python run.py broadleaf` works with the same script (bootstrap handled by harness)

---

## Out of Scope (future milestones)

- Loop mode: `python run.py beaverhabits --runs 5` to aggregate scores across iterations
- CI integration: run on a schedule and post results to Slack/Linear
- Skill branch sweep: run same app against multiple skill commits and diff results
