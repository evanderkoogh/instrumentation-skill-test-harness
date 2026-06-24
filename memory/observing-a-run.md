---
name: observing-a-run
description: How to get the full picture of a harness run — local logs + the three Honeycomb telemetry streams and how to scope to one run
metadata: 
  node_type: memory
  type: reference
  originSessionId: 954050d9-7ec5-40cd-adcc-0b70b2fc2575
---

To see everything a run did, combine local artifacts with Honeycomb telemetry.

**The one id that ties a run together:** `runId` = `<app>-<ISO timestamp>` (e.g. `broadleaf-2026-06-24T07:01:02.127Z`), generated per app-run in `run.ts`. It appears as `harness.run_id` on app + agent telemetry and as `gen_ai.conversation.id` on agent telemetry. Filter on it to scope any query to a single run. `runs.jsonl` records `app` + `timestamp`, so `<app>-<timestamp>` reconstructs the runId.

**Local (fastest):**
- `tail -f tmp/run-progress.<app>.log` — live phase markers + final PASS/FAIL (truncated at each run start, so it only shows the current run).
- `runs.jsonl` — final recorded result: token/cost metrics + per-criterion pass/fail + weaver. Each `--parallel` child appends independently when it finishes.
- `logs/<app>/` — app server, collector, weaver, and `agent-collector.log`.

**Honeycomb (team `otel-test`, env `claude-skill-test`) — three separate streams:**
1. **`<APP_DATASET>`** (e.g. `broadleaf-site`, `realworld-go`, `beaverhabits`) — the *instrumented app's* telemetry. This is what the evaluation scores. Scope by `harness.run_id` (stamped by the app collector, `collector.template.yaml`).
2. **`<app>-instrumentation`** — the *agent's own* behavior, remapped claude_code.* → gen_ai.* by the per-run agent collector (`collector.agent.template.yaml`). Span names: `invoke_agent …` (root), `chat <model>`, `execute_tool <tool>`. Scope by `gen_ai.conversation.id`/`harness.run_id`. **Slice by `query_source`** (e.g. `agent:custom:honeycomb:otel-instrumenter`) to see which sub-agent (conductor / otel-instrumenter / otel-verifier) did what.
3. **`instrumentation-skill-harness`** — `run.ts`'s own orchestration spans (`run`, `build`, `instrument`, `instrumentation-agent`, `evaluate`) carrying `agent.*`, `skill.*`, and `criterion.*` attributes.

**Rich agent content** (opt-in vars set in `src/instrumentation.ts`, all in stream 2):
- `tool.output` span events — full tool input + output (`bash_command`, `output`).
- `api_request_body` / `api_response_body` log events — the full prompts (incl. system prompt, conversation history) and model responses. Filter `meta.signal_type = log`.
- `tool_result` events carry `tool_input`/`tool_parameters` (these are *event* attrs, not span attrs — see [[genai-conventions-agent-telemetry]]).

See [[genai-conventions-agent-telemetry]] for how stream 2 is built and why. The agent telemetry is observability of the harness itself, not part of the scored deliverable ([[project-goal-portable-skills]]).
