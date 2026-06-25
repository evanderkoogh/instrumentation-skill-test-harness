---
name: rebuild-images-after-harness-change
description: Always rebuild the agent Docker images after editing any bundled/baked harness file
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1619c3f2-b96c-438b-b9ce-a60f2d656576
---

After changing any harness file that is **baked into the agent images**, always run an image rebuild — base first, then the language images — as part of the same change, without being asked.

Baked files include: `src/*.ts` (instrumentation.ts, run-agent.ts, run-eval.ts, sandbox.ts, evaluation.ts, weaver.ts, envvars.ts, pricing.ts, container is host-side so NOT baked), `harness.sh`, `ports.sh`, `docker/lifecycle.sh`, `collector.run.template.yaml`, `EVALUATION.md`, `apps/`. See `docker/agent-base.Dockerfile` COPY lines for the authoritative list.

**Why:** the images bake the harness code at `/harness`; edits to baked files have **no effect** until the image is rebuilt, so a run after an un-rebuilt edit silently exercises the old code.

**How to apply:**
- `docker build -f docker/agent-base.Dockerfile -t harness-agent-base .` then the `agent-<lang>` images that derive from it (changing the base busts the language images' `FROM` layer, so they rebuild too).
- Layering (restructured 2026-06-25): the **base** holds only runtime + weaver + otelcol + `npm ci` (slow-changing); the harness **source COPY lives in each `agent-<lang>` image as its final layers, after the toolchain install**. So a source-only edit re-runs only the cheap per-language COPY layers — `npm ci` AND the language toolchains (Go tarball, JDK/Maven, uv) all stay **CACHED**. Verify that on rebuild. `container.ts` is host-side (not baked) → no rebuild needed for it.

See [[run-under-caffeinate]] and [[project_containerize_eval_plan]].
