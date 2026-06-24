---
name: orchestrator-as-planner
description: Direction for the otel-instrumentation conductor — it should also plan and ask the user interactive questions
metadata: 
  node_type: memory
  type: project
  originSessionId: 417a2b80-b798-4244-acd3-9b6ceb9a1a24
---

The `otel-instrumentation` conductor skill (the orchestrator) should evolve into the **planner** for the engagement, not just a dispatcher. Beyond coordinating the `otel-instrumenter` and `otel-verifier` sub-agents, it should gather everything those two agents need up front — and **ask the user interactive questions** when it's missing required information (e.g. how to start/exercise the app, ports, auth, OTLP endpoint, which signals/scope) rather than letting a sub-agent guess or fail.

Rationale: the sub-agents run in fresh, context-less sessions and only know what the conductor puts in their prompts. Today the conductor relays whatever it was given and tells the sub-agent to "discover it itself" if absent — which wastes cycles and produces guess-driven work. Making the conductor responsible for detecting gaps and resolving them (interactively with the user) before delegating is more reliable.

Already moving in this direction (2026-06-23): the conductor now detects whether a weaver registry exists in the checkout and gives the verifier an unambiguous "run a weaver live-check" directive instead of leaving that decision to the verifier — see [[trunk-based-dev]] (agent-skill repo, `evanderkoogh/major-instrumentation-refactor` branch). The planner role generalizes that pattern. Not yet fully implemented; revisit when extending the conductor skill.
