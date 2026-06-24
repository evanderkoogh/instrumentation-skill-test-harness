---
name: feedback-no-preamble-edits
description: Never add instrumentation guidance to an app's instrument-preamble.md; preambles hold only general framing + app-specific facts needed to start. Suggest-and-ask, never bake in.
metadata:
  type: feedback
---

An application's `instrument-preamble.md` (under `apps/<name>/`) may contain **only** two kinds of
content: (1) the general, app-agnostic framing of the instrumentation task, and (2) the app-specific
*facts* the agent needs to begin (what the app is, its language/framework, the dataset/service name to
use, how to reach it). It must **never** contain instrumentation *instructions* — any guidance about
*how* to instrument (techniques, attribute choices, fixes, gotchas, "do X to avoid Y"). All such
guidance belongs in the skill (`agent-skill/honeycomb/skills/.../SKILL.md`).

You may **suggest** a preamble change and **ask for explicit permission**, but never add instrumentation
instructions to a preamble on your own — and if a "fix" really is instrumentation guidance, the answer
is to put it in the skill, not to ask to add it to the preamble.

**Why:** The deliverable is a **portable instrumentation skill**, not perfectly-instrumented sample
apps. The skill must carry all instrumentation guidance so that *the skill* is what gets evaluated.
Baking how-to-instrument hints into a preamble leaks app-specific answers, makes the app pass for the
wrong reason, and invalidates the test of whether the skill stands on its own. See
[[project-goal-portable-skills]].

**How to apply:** When a run surfaces something the agent should do during instrumentation (e.g.
"set service.name", "raise the BSP queue size", "disable the agent's self-telemetry"), generalize it
into the SKILL.md — never the preamble. Keep preambles to minimal app context + start-up facts only.
Harness config (`config.sh`) and evaluation (`evaluation.ts`, `EVALUATION.md`) changes are fine
without asking.
