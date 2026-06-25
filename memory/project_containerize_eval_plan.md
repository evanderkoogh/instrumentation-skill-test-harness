---
name: project_containerize_eval_plan
description: Approved-pending plan to run the full per-run lifecycle (build+start+traffic+evaluate) in one container via single image + sandbox
metadata: 
  node_type: memory
  type: project
  originSessionId: 8664a4e1-bf0c-4c5e-b4e3-0dd4282af554
---

Next major harness work (planned 2026-06-25, to start fresh 2026-06-26). Full plan lives at
`~/.claude/plans/create-a-plan-for-pure-moon.md` — read it first.

**Goal:** extend `HARNESS_CONTAINERIZE` beyond the agent step so build + start + traffic + evaluate
all run inside **one per-language image** (`harness-agent-<lang>`), app+collector+weaver+scoring in one
netns. download/reset/instrument/record stay on host (git/text/ledger).

**Key decisions (settled with Erwin):**
- **Single image, not a separate eval image.** Bake the full harness code incl. the eval "answer key"
  (`src/evaluation.ts`, `weaver.ts`, `envvars.ts`, `EVALUATION.md`, `apps/`) into the image, and rely on
  `src/sandbox.ts` to deny the agent reading it. Works with ZERO sandbox changes — `makeFsGuard` is
  already a default-deny whitelist over the whole harness tree (only checkout + `otel/` allowed). Posture
  then equals the current host run; we drop only the containerized "physically absent" extra layer.
- Agent step = image + sandbox ON; build/start/traffic/evaluate = same image, different entrypoint,
  sandbox OFF (trusted harness code).
- **Caching preserved** via existing `tmp/.home-<app>` + java `~/.m2` mounts (dependency caches in HOME,
  mounted at run-time; unifies the currently-split host-build vs container-agent caches for Go/Python).
- Moving start+traffic in (not just collector/weaver) is what collapses `ports.sh` / `free_port` /
  lsof kill-before-start — the half-measure (collector/weaver only, app on host) was rejected as awkward.

**Hard constraint found:** weaver `--input-format json` is NOT OTLP-JSON (it's weaver's own sample
schema; see `collector.run.template.yaml:10-11`). So weaver must stay a live OTLP receiver → the
start/traffic/eval container is long-lived (`docker run -d` + `docker exec`), not a one-shot replay.

**Phasing:** (1) bake answer key + verify sandbox denies it, no behavior change; (2) evaluate in a
one-shot container (collector/weaver still host, finalize via host.docker.internal); (3) move
start+traffic+telemetry into a long-lived container, delete host port plumbing; (4 optional) build
in-container. Mirror existing patterns in `src/container.ts` (host-rewrite, secret-by-name, JSON
read-back) and `src/run-agent.ts`.

Related: [[project-goal-portable-skills]] (this is a harness/measurement change, not a skill change).
