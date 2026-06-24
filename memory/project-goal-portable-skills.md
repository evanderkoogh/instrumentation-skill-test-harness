---
name: project-goal-portable-skills
description: "The deliverable is portable instrumentation skills, not the test harness — don't propose harness changes to improve instrumentation quality"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10e0804c-5e4f-4dc9-8090-e6928a20e6dd
---

The goal of this project is to develop OpenTelemetry instrumentation **skills**
(e.g. `agent-skill/.../otel-instrumentation/SKILL.md`) that other people will use on
their own, unrelated projects — completely independent of this test harness. The harness
is only a measurement rig: it runs a fresh, clean-context agent against target apps and
scores the result, so we can iterate on the skill.

**Why:** Whatever ships is the skill alone. The harness (and its `EVALUATION.md`,
`harness.sh`, collector, `env_var_output`/weaver criteria, sandbox, etc.) will not exist in
the environments where the skill is actually used.

**How to apply:** When instrumentation quality is poor, fix it in the **skill** — that's the
only artifact that travels. Do **not** suggest harness-side changes to *improve
instrumentation quality* (e.g. Stop-hook completion gates, verify→fix loops, the harness
generating traffic or enforcing verification): those would make the harness pass but teach
the skill nothing portable, and they can't run on the user's project. Harness changes are
only appropriate to make the **measurement** more accurate/realistic (e.g. simulating what
a real operator's environment provides, fixing eval criteria, isolation). The real test of
a skill change is whether it makes an independent agent produce good instrumentation with
no harness present.
