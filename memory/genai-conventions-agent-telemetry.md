---
name: genai-conventions-agent-telemetry
description: "How the harness captures the instrumentation agent's own telemetry as GenAI-convention spans in Honeycomb (collector remap + opt-in content vars)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 954050d9-7ec5-40cd-adcc-0b70b2fc2575
---

The instrumentation agent's own behavior is captured as a GenAI-convention agent timeline in Honeycomb (dataset `<app>-instrumentation`). How it's built:

- **The SDK already emits gen_ai-ish spans.** With `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` (set in `src/instrumentation.ts`), the Claude Agent SDK emits `claude_code.interaction` (root) / `claude_code.llm_request` / `claude_code.tool` spans with partial gen_ai attrs (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.*`) — but **no `gen_ai.conversation.id`**, so Honeycomb's agent view can't group a run.
- **A per-run agent collector does the remap.** `run.ts` calls `harness.sh agent-collector-start` before `runInstrumentation` and `…-stop` after; the SDK's OTLP export is pointed at it (endpoint published to `tmp/.harness.<app>.agent-collector.endpoint`, read back by `startAgentCollector`). Config: `collector.agent.template.yaml` — a `transform` processor renames spans (`invoke_agent`/`chat`/`execute_tool`), sets `gen_ai.operation.name`, aliases tokens (`input_tokens`→`gen_ai.usage.input_tokens`, etc.) and `gen_ai.tool.name`; a `resource` processor stamps `gen_ai.conversation.id` + `gen_ai.agent.name` + `harness.run_id`. Recipe follows Honeycomb's "Remapping existing telemetry" doc. Falls back to direct-to-Honeycomb export if the collector can't start.
- **conversation.id = the harness runId**, not the SDK's `session.id` — so agent telemetry, app telemetry, and the run record all key off the same value.

**Gotchas / facts learned:**
- The SDK does NOT emit a single `tool_input` SPAN attribute (Honeycomb's generic recipe assumes one); no version through 2.1.187 does. Tool input lives in per-tool SPAN attrs (`full_command` for Bash, `file_path` for file tools, populated by `OTEL_LOG_TOOL_DETAILS=1`). The remap maps those → `gen_ai.tool.call.arguments`.
- Tool OUTPUT and full prompt/response bodies are EVENTS, not span attributes, so OTTL (span context) can't hoist them onto a span — query them as events/logs instead.
- Opt-in content vars (set in `src/instrumentation.ts`; all default-off, sent only to our Honeycomb, never to Anthropic): `OTEL_LOG_TOOL_CONTENT=1` (full tool I/O as `tool.output` span events), `OTEL_LOG_RAW_API_BODIES=1` (full request/response JSON as `api_request_body`/`api_response_body` log events), `OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_TOOL_DETAILS=1`.

To actually look at a run's data, see [[observing-a-run]].
