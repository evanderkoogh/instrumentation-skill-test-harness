---
name: full-run-report-spec
description: "Spec for building a full HTML report of an instrumentation run from its Honeycomb telemetry — sections, order, and the data behind each"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 954050d9-7ec5-40cd-adcc-0b70b2fc2575
---

This is the STANDARD run-report format — use it by default whenever a report/overview of a run is requested (it supersedes the earlier call-table-only version). Produce ONE self-contained HTML file (inline CSS/JS, no external deps) built entirely from that run's telemetry in Honeycomb. Scope everything to the run via `gen_ai.conversation.id` = the runId (`<app>-<ISO timestamp>`); see [[observing-a-run]] for the three streams and [[genai-conventions-agent-telemetry]] for how the agent telemetry is shaped + which content lives in log events vs span attrs.

Sections, in this order:

1. **Run-level metrics** (top): wall-clock time spent, tokens used (in / out / cache-read / cache-write), total cost, and pass rate. Include the full per-criterion pass/fail table. Sources: `runs.jsonl` record (criteria, agent metrics, weaver) for the authoritative result; the `instrumentation-skill-harness` orchestration spans and the agent's `chat` spans / `api_request` events for token + timing rollups.

2. **Failure investigations**: for EVERY failed criterion, investigate what went wrong and WHY — root cause, not just the symptom. Read the relevant report (e.g. weaver `logs/<app>/weaver-report/live_check.json`), the failing telemetry, and the agent's own actions. Classify the cause: **skill defect** (fixable in the skill — e.g. a weaver registry that doesn't `import` upstream semconv → tens of thousands of `missing_attribute` violations), **upstream library lag** (not skill-fixable — e.g. SQLAlchemy pool metric emitting deprecated `state`/`pool.name`, ungated by the semconv opt-in), or **measurement artifact** (harness scoping issue). State which, with evidence.

3. **Agent-interaction overview**: how the agents related to each other — the conductor's dispatch sequence and hand-offs (e.g. instrument → verify → fix → re-verify → PASS), how many sub-agents and of which type (otel-instrumenter / otel-verifier / Explore), and verifier round count. Derive from `query_source` on each span + the dispatch ordering/timestamps.

4. **Per-agent high-level actions** (longer form): for each agent/sub-agent, a narrative of the high-level actions it took (what it explored, what it instrumented/changed, what it verified/found). Summarize from each agent's `api_response_body` reasoning text + the tool calls it issued.

5. **Full call table**: every tool call AND every LLM call, chronological, each row with a short human-readable summary of what happened (LLM: the model's reasoning gist + decision; tool: what the command/edit/read did + its outcome). **Clicking a row expands it** to show ALL information for that call — for LLM calls the full request/response bodies (`api_request_body`/`api_response_body`), token usage, finish reason, duration; for tool calls the full input (`gen_ai.tool.call.arguments`/`full_command`/`file_path`) and full output (`tool.output` span event), duration, sub-agent. (Implement expand with a tiny inline `<details>`/JS toggle — still no external deps.)

Practical: bodies are large (≤60 KB each, hundreds of calls) — summarize in the row, keep full content in the collapsed detail. Write to `reports/agent-run-overview-<app>.html` (or similar). Per-app background agents that wait for the run to finish then build this are the working pattern (poll `tmp/.run.<app>.pid` disappearing as the finished signal).
