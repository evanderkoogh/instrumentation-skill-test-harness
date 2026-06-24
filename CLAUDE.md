# OTel Skill Test Harness

This project exists to repeatedly test Claude's OpenTelemetry instrumentation skills against real application codebases in various languages and frameworks.

## Structure

```
run.ts                # Full-run orchestrator: reset → build → instrument → start → traffic → evaluate
src/
  instrumentation.ts  # Agent SDK runner — calls the instrumentation agent via @anthropic-ai/claude-agent-sdk
  evaluation.ts       # Honeycomb query-based evaluation criteria
  weaver.ts           # Finalizes + parses the weaver live-check report (weaver_live_check criterion)
  harness.ts          # Helpers that wrap harness.sh commands
  metrics.ts          # Run record persistence (runs.jsonl) and summary printing
harness.sh            # Low-level step runner: reset, build, bootstrap, start, stop, traffic, instrument
collector.run.template.yaml  # Per-run OTel Collector config (fan-out to Honeycomb + weaver live-check)
otel/                 # Downloaded tooling (gitignored): Java agent, weaver, otelcol-contrib
apps/
  <app>/              # One directory per target app (e.g. broadleaf, realworld-go, beaverhabits)
    config.sh         # App-specific variables (incl. the APP_* facts for the prompt) and start/stop/build hooks
    traffic.sh        # Traffic generation script
    EVALUATION.md     # Evaluation checklist for this app
checkouts/
  <app>/              # Cloned app code (gitignored)
```

The agent prompt is one preamble rendered from a shared, user-voice template
(`instrument-preamble.template.md` at the repo root) filled with each app's `APP_*` facts from
`config.sh` — there are no per-app preamble files. To add a new app, create `apps/<name>/` with
`config.sh` (including its `APP_*` fact vars), `traffic.sh`, and `EVALUATION.md`. No changes to shared
harness code required.

## Purpose

Each session simulates a fresh instrumentation engagement on a target application. The scripts in this repo exist to quickly reset the target to a clean, pre-instrumentation state so the same skill can be re-tested without leftover changes from a previous run.

## Workflow

Run a full test with:

```
npx tsx run.ts broadleaf                  # one app (runs inline)
npx tsx run.ts broadleaf realworld-go     # several apps, sequentially
npx tsx run.ts all --parallel             # every app under apps/, concurrently
npx tsx run.ts kill [app...|all]          # cleanly stop active run(s)
```

Each in-flight run records a PID file (`tmp/.run.<app>.pid`). Starting an app whose run is
already active is **refused** (avoids port/log collisions), and `run.ts kill <app|all>` stops
the run process and its app server / collector / weaver — use this rather than hand-rolled
`pkill`, which misses the child processes and leaves orphans that corrupt later runs' logs.

With more than one app, `run.ts` spawns one isolated child process per app
(`--parallel` runs them concurrently; otherwise sequentially) and prints a
combined pass/fail summary. Each app uses app-scoped logs (`logs/<app>/`), PID
file (`tmp/.harness.<app>.pids`), and prompt (`tmp/.instrument-prompt.<app>.md`), so
concurrent runs don't collide. All generated run-scoped scratch files live under
`tmp/` (gitignored), not the repo root. For `--parallel`, each app must bind distinct
ports — configured per app in `apps/<app>/config.sh` (`APP_HTTP_PORT` and any
other listener vars the app defines).

**Watching live progress:** each run writes phase markers and its final result to
`tmp/run-progress.<app>.log`, which is **truncated at the start of every run** — so
`tail -f tmp/run-progress.<app>.log` always reflects only the current run for that app.
Tail this rather than piping `run.ts` stdout through `tail` (buffers until exit) or
reading any hand-made cross-run redirect log (mixes stale entries from earlier runs).

During `start`, the harness also brings up a per-run OTel Collector + `weaver registry
live-check` OTLP receiver (dynamically-allocated ports, app-scoped config/pid/state) and
points the app's OTLP export at the collector, which fans telemetry out to **both**
Honeycomb (for the query-based criteria) and weaver (for the `weaver_live_check`
criterion). Disable with `HARNESS_WEAVER_CAPTURE=0`. Requires `download-tools` to have
fetched `otel/weaver` + `otel/otelcol-contrib`; if absent the harness falls back to
exporting straight to Honeycomb and skips the weaver criterion.

This orchestrates the complete cycle automatically:

1. `reset --purge` — discard the current scratch branch and create a fresh `scratch_YYYY-MM-DD` branch from `clean`
2. `build` — build all modules
3. `bootstrap` — one-time setup (e.g. seed a database) if the app defines it; skipped automatically if already done
4. `instrument` — generate `tmp/.instrument-prompt.<app>.md` from the skill content + app preamble
5. Agent SDK run — `src/instrumentation.ts` drives a clean-context agent via `@anthropic-ai/claude-agent-sdk` with the prompt, no conversation history
6. `start` — launch the app's server(s) in the background (ports configured in `apps/<app>/config.sh`)
7. `traffic` — generate representative traffic across key paths
8. Evaluate — `src/evaluation.ts` queries Honeycomb and checks pass/fail criteria
9. Record — results appended to `runs.jsonl`

> **Note on bootstrap:** Some apps persist `bootstrap` state outside the checkout (e.g. a seeded database under `/tmp`), which can survive session restarts but be cleared on system reboot. If `start` fails with a schema/setup error, run `./harness.sh <app> bootstrap` manually before re-running.

## Containerized agent runs (`HARNESS_CONTAINERIZE`)

By default the instrumentation agent (step 5) runs **in-process on the host**, so its Bash shares the
host process table, port space, and `/tmp` with the harness's own scoring weaver/collector and any
concurrent `--parallel` runs. That makes the agent burn turns on `ps`/`lsof`/`kill` disambiguation
(*"is this weaver mine or the harness's?"*) — pure overhead that the portable skill can't be taught
to avoid without harness-specific instructions.

Set **`HARNESS_CONTAINERIZE=1`** to run **only the agent step** inside a Docker container instead. The
images share a base layer (`harness-agent-base`: Node runtime, weaver, baked harness code, Node deps);
each language image (`harness-agent-{python,go,java}`) just adds its toolchain. **Build the base first**,
then the language image(s) — rebuild the base whenever harness code or deps change:

```
docker build -f docker/agent-base.Dockerfile   -t harness-agent-base   .   # base: one-time / on harness-code change
docker build -f docker/agent-python.Dockerfile -t harness-agent-python .   # + uv
docker build -f docker/agent-go.Dockerfile     -t harness-agent-go     .   # + Go toolchain (CGO_ENABLED=1)
docker build -f docker/agent-java.Dockerfile   -t harness-agent-java   .   # + JDK 17 + Maven + OTel java agent jar
HARNESS_CONTAINERIZE=1 npx tsx run.ts beaverhabits   # python · realworld-go (go) · broadleaf (java)
```

The container has its own PID + network namespace, so the skill's generic process/port commands only
ever see the agent's own world. Everything else (`reset`/`build`/`instrument`, then `start`/`traffic`/
`evaluate`/weaver scoring/record) still runs on the host, unchanged — only `runInstrumentation()` is
relocated. Supported for **all three apps** (Python/Go/Java); a new app's language just needs a
`harness-agent-<lang>` image. `node` apps would need one too.

How it fits together:
- **`src/container.ts`** launches `docker run` (replacing the in-process call in `run.ts`); **`src/run-agent.ts`** is the in-container entrypoint that calls the same `runInstrumentation()` and writes `AgentMetrics` to `tmp/.agent-metrics.<app>.json`, which the host reads back.
- **Image selection:** `src/container.ts` picks `harness-agent-<lang>` from the app's `APP_OTEL_AGENT_TYPE` (surfaced via `readAppConfig` in `src/harness.ts`). `HARNESS_AGENT_IMAGE` overrides as an escape hatch.
- The image bakes the harness code at **`/harness`** so paths resolve exactly as on the host (`harnessRoot=/harness`, `repoDir=/harness/checkouts/<app>`, `pluginRoot=/harness/agent-skill/honeycomb`) — `src/instrumentation.ts` and `src/sandbox.ts` run **unchanged**.
- **Mounts:** the checkout (RW, so edits land on the host checkout the host later scores), `tmp/` (RW), and the skill tree (RO at `/harness/agent-skill/honeycomb`). The eval "answer key" (`src/evaluation.ts`, `weaver.ts`, `envvars.ts`, `EVALUATION.md`, `apps/`) is **never copied into the image** (see `.dockerignore`), so it's physically absent — stronger than the host's `PreToolUse` sandbox.
- **Writable HOME:** `--user <host-uid>` leaves the container with no home dir, so `HOME` is pointed at `/harness/tmp/.home-<app>` (under the bind-mounted, host-uid-owned `tmp/`, pre-created host-side) — giving Go (`GOPATH`/`GOCACHE`), Maven (`~/.m2`), and uv a writable, host-persisted cache location.
- **Per-language / per-app extra mounts:** the **java** image mounts the host `~/.m2` (RW) into `HOME/.m2` so Maven doesn't re-download ~1 GB each run; **broadleaf** also mounts (a) the host-seeded `/tmp/broadleaf-hsqldb` (run `./harness.sh broadleaf bootstrap` first) so the agent's verification boot finds the correct schema, and (b) the host's cached Solr distribution — Broadleaf downloads ~225 MB of Solr from the rate-limited archive.apache.org into `${java.io.tmpdir}/solr-<ver>` on first boot, so `src/container.ts` binds the host's copy (`os.tmpdir()/solr-<ver>`, where prior host runs already cached it) to the container's `/tmp/solr-<ver>`. Note `java.io.tmpdir` is the per-user `$TMPDIR` on the macOS host but `/tmp` in the Linux container — hence the cross-path mount.
- **Networking:** under the flag the agent-telemetry collector binds `0.0.0.0` (not `127.0.0.1`) and `src/container.ts` rewrites its endpoint host to `host.docker.internal`, so the SDK's own telemetry still reaches the host collector → Honeycomb. The container publishes **no** ports, so the agent's own app boots (broadleaf's HTTP/HTTPS/HSQLDB:9001 etc.) bind only inside its netns and can't collide with the host.
- **weaver:** the base image ships a statically-linked **musl** Linux weaver (the host `otel/` weaver is a macOS binary and isn't mounted; the `latest` gnu build needs a newer glibc than the base image).
- **Go (cgo):** realworld-go's SQLite driver (`mattn/go-sqlite3`) is cgo, so the Go image sets `CGO_ENABLED=1` and relies on `build-essential` (gcc) from the base.
- **Java agent jar:** the skill downloads the latest OTel java agent itself (host parity); the java image also **bakes a copy** at `/opt/otel/opentelemetry-javaagent.jar` as an offline fallback.
- **Memory (broadleaf):** broadleaf needs GB-scale RAM (site + admin JVMs, `MAVEN_OPTS=-Xmx1g`); ensure the Docker Desktop VM has **≥6-8 GB** before a broadleaf run.

**Auth requirement:** the SDK authenticates from `run.ts`'s environment, and `src/container.ts`
forwards the credential vars **by name** (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`). So `ANTHROPIC_API_KEY` (or equivalent) must be
**exported in the shell that launches `run.ts`**. If you authenticate via a Claude Code OAuth
credentials file (`~/.claude/.credentials.json`) rather than an env var, the container won't see it —
mount that file in (it isn't, currently).

Editing harness code that the agent step uses (`src/instrumentation.ts`, `sandbox.ts`, `pricing.ts`,
`run-agent.ts`) requires a `docker build` to take effect, since the image bakes those files.

## harness.sh — Individual Steps

`harness.sh` exposes each step individually for debugging. `run.ts` calls these internally; you rarely need to invoke them directly. Two env vars are required: `OTEL_EXPORTER_OTLP_HEADERS` (ingest key) and `HONEYCOMB_QUERY_API_KEY` (query key with Query Data permission) — both read from `.env`.

Run any step as `./harness.sh <app> <cmd>`:

- `download` — clone the app repo (skips if already present)
- `download-agent` — download the OTel agent for the app's language (if it uses one)
- `download-tools` — download `weaver` + `otelcol-contrib` to `otel/`
- `build` — build the app
- `bootstrap` — one-time setup (e.g. seed a database), if the app defines it
- `instrument` — generate `tmp/.instrument-prompt.<app>.md` (used internally by `run.ts`)
- `start` / `stop` / `restart` / `status` — manage the app's server(s) in the background
- `traffic` — generate representative traffic against the running app
- `reset [--purge]` — check out the app's `clean` baseline and create a fresh scratch branch
- `clean` — remove logs and Playwright session artifacts

Each app's checkout has a `clean` branch (the unmodified upstream baseline — never commit instrumentation changes there) and per-run `scratch_YYYY-MM-DD[-N]` working branches.

## Browsing a running app

Use the **Playwright MCP** tools (`playwright_navigate`, `playwright_screenshot`, etc.) when interacting with a running app's UI. Do not use `curl`, `WebFetch`, or raw HTTP calls to browse or verify UI behavior.

## Constraints

**All OpenTelemetry instrumentation changes must be made inside the target app's `checkouts/<app>/` only.** The root-level directory and `apps/<app>/` config files are the test harness and must never be modified as part of an instrumentation task. If an instrumentation skill tries to create or edit files outside `checkouts/<app>/`, that is a mistake.

This is enforced — not just documented — by a hard sandbox on the instrumentation agent (`src/sandbox.ts`, wired in as a `PreToolUse` hook in `src/instrumentation.ts`). The agent's filesystem access within the harness tree is confined to its own `checkouts/<app>/` plus the bundled `otel/` tooling (so it can run `weaver`); any `Read`/`Write`/`Edit`/`Bash` that touches the harness's own files — `src/` (incl. `evaluation.ts`/`weaver.ts`), `EVALUATION.md`, `harness.sh`, collector/weaver config, `.env`, or other apps' checkouts — is denied. Paths outside the harness entirely (system toolchains, dependency caches, `$HOME`, `/tmp`) stay reachable so the agent can still build and verify. This prevents the agent from reading the eval criteria ("the answer key") and overfitting the score.

## Reviewing a skill

The skills under `agent-skill/` are the deliverable. When reviewing or editing one, read it **as the
agent that will actually run it** — a fresh, context-less agent whose *only* inputs are the skill text
plus whatever the harness hands it. It cannot see this repo, prior runs, the evaluation criteria, or the
reasoning behind a given line. Judge the skill purely on whether that agent, with those inputs, can
follow it to a correct result. Review each skill from its real entry points:

- **`otel-instrumentation-implementation`** — the reader is a context-less implementer that arrives in
  one of two states: (a) an **initial instrumentation prompt** (repo path + app facts, nothing more),
  or (b) a set of **verification findings to fix** and nothing else. The skill must stand on its own in
  both: a first-time implementer must be able to instrument from zero, and a fix-cycle implementer must
  be able to act on findings it was handed without re-deriving the whole engagement.
- **`otel-verification`** — the reader is a **clean agent handed an already-instrumented app**, with no
  knowledge of what was changed or why. It must be able to discover how to run and exercise the app, see
  the emitted telemetry, and judge it against the contract from scratch.

Guidelines for what to write into a skill:

- **Avoid "scar tissue."** Don't accrete hyper-specific defensive instructions from individual past
  failures. Each run surfaces a concrete defect, but the fix in the skill should be the *general
  principle* that prevents the class of defect — not a narrow patch describing that one occurrence.
  Excess scar tissue makes a skill long, brittle, and overfit to the apps we happen to test.
- **Don't hardcode attribute (or metric) names unless absolutely necessary.** Prefer general, reactive
  guidance (e.g. "catalogue any passed-through library attribute the live-check flags") over naming
  specific attributes. Hardcoded names overfit to today's apps/instrumentation versions and rot quickly.

(More review guidance will be added here as we learn more.)

## Adding a new app

1. `mkdir apps/<name>`
2. **Claim ports in `ports.sh`** (the central registry) — add the app to `registered_apps()` and `app_ports()`, and define a var for **every** port it binds, including *implicit* ones the framework opens (embedded DBs, admin connectors, etc. — e.g. Broadleaf's HSQLDB on 9001). Ports must be globally disjoint; run `./harness.sh <name> ports` to verify no collisions. The harness kills processes on these ports before each `start`, so they must be accurate.
3. Create `apps/<name>/config.sh` — set `APP_NAME`, `APP_REPO`, `APP_CLEAN_SHA` (a commit SHA from the upstream repo; no fork required), `APP_OTEL_AGENT_TYPE`, reference the registry port vars (e.g. `APP_HTTP_PORT="$<NAME>_HTTP_PORT"`), and define `cmd_build()`, `cmd_start()` (and optionally `cmd_bootstrap()`, `cmd_status()`). Also set the **`APP_*` fact vars** the shared prompt template renders: `APP_DATASET` (service name), `APP_DESCRIPTION`, `APP_LANGUAGE`, `APP_FRAMEWORKS`, `APP_CODE_LOCATION`, `APP_BUILD_HINT`, `APP_START_HINT`, `APP_ENV_SURFACE`, `APP_READINESS` (and optionally `APP_STOP_HINT`, `APP_ATTR_NAMING`, `APP_WEAVER_REGISTRY`, `APP_IMPORT_REGISTRIES`). Anything you omit falls back to a sensible default in `harness.sh`. Keep these to **plain app facts** — no instrumentation how-to (that lives in the skill).
4. Create `apps/<name>/traffic.sh` — standalone script that generates traffic against the running app (use `${APP_HTTP_PORT}` etc., never hardcode ports)
5. Create `apps/<name>/EVALUATION.md` — evaluation checklist for verifying instrumentation quality

(No per-app preamble file: the prompt is the shared `instrument-preamble.template.md` filled from the `APP_*` vars above. Avoid em-dashes/apostrophes inside `${VAR:-default}` defaults in `harness.sh` — macOS bash 3.2 mis-parses them.)
7. Run `./harness.sh <name> download` to clone the repo
