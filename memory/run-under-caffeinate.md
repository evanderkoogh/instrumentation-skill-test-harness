---
name: run-under-caffeinate
description: "Always wrap harness runs in `caffeinate` so laptop sleep can't corrupt them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6a4ab46c-d753-41e9-a258-f55bb826c382
---

Always launch `run.ts` (any app, especially `all --parallel`) wrapped in macOS `caffeinate`:

```
caffeinate -dimsu npx tsx run.ts all --parallel
```

(`-dimsu` blocks display, idle, disk, and system sleep for the life of the command.)

**Why:** these runs take ~20–35 min. If the laptop sleeps mid-run it corrupts the
result — the agent SDK's API socket drops, app servers / weaver receivers / collectors
started before sleep wedge or die (breaking start/traffic/evaluate), durations are skewed
by the sleep gap, and the orchestrator may re-spawn a dead sub-agent ("Resume instrumenter").
A contaminated run is not a trustworthy before/after; it has to be re-run. This has happened
more than once.

**How to apply:** prepend `caffeinate -dimsu` to every harness run launched in the
background. If a run is found mid-flight after a sleep, kill it ([[run-under-caffeinate]] via
TaskStop + pkill of `run.ts`/`weaver registry live-check`/`otelcol-contrib`) and re-run.
