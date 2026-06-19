---
name: feedback-no-preamble-edits
description: Never edit app instrument-preamble.md files without explicit permission; instrumentation directions go in the skill
metadata:
  type: feedback
---

Never change an application's `instrument-preamble.md` (under `apps/<name>/`) without the user's explicit permission. Any instructions about *how* to instrument belong in the skill (`agent-skill/honeycomb/skills/.../SKILL.md`), not the per-app preamble.

**Why:** This repo exists to develop and test the instrumentation skill. The skill must carry all instrumentation guidance so it's what gets evaluated; baking directions into a preamble would leak app-specific hints and invalidate the test.

**How to apply:** When a task needs the agent to do something during instrumentation (e.g. "hardcode service.name"), put it in the SKILL.md. Leave preambles as minimal app-context only. Harness config (`config.sh`) and evaluation (`evaluation.ts`, `EVALUATION.md`) changes are fine without asking.
