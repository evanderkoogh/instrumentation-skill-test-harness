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
collector.template.yaml  # Per-run OTel Collector config (fan-out to Honeycomb + weaver live-check)
otel/                 # Downloaded tooling (gitignored): Java agent, weaver, otelcol-contrib
apps/
  <app>/              # One directory per target app (e.g. broadleaf, realworld-go, beaverhabits)
    config.sh         # App-specific variables and start/stop/build hooks
    traffic.sh        # Traffic generation script
    instrument-preamble.md  # App-specific intro injected into the agent prompt
    EVALUATION.md     # Evaluation checklist for this app
checkouts/
  <app>/              # Cloned app code (gitignored)
```

To add a new app, create `apps/<name>/` with `config.sh`, `traffic.sh`, `instrument-preamble.md`, and `EVALUATION.md`. No changes to shared harness code required.

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
3. Create `apps/<name>/config.sh` — set `APP_NAME`, `APP_REPO`, `APP_CLEAN_SHA` (a commit SHA from the upstream repo; no fork required), `APP_OTEL_AGENT_TYPE`, reference the registry port vars (e.g. `APP_HTTP_PORT="$<NAME>_HTTP_PORT"`), and define `cmd_build()`, `cmd_start()` (and optionally `cmd_bootstrap()`, `cmd_status()`)
4. Create `apps/<name>/traffic.sh` — standalone script that generates traffic against the running app (use `${APP_HTTP_PORT}` etc., never hardcode ports)
5. Create `apps/<name>/instrument-preamble.md` — app-specific intro injected before the skill content; use `%REPO_DIR%`, `%API_KEY%`, `%OTLP_ENDPOINT%`, `%APP_DATASET%` as substitution placeholders
6. Create `apps/<name>/EVALUATION.md` — evaluation checklist for verifying instrumentation quality
7. Run `./harness.sh <name> download` to clone the repo
