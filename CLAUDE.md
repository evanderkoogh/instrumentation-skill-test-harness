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
```

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

## Adding a new app

1. `mkdir apps/<name>`
2. Create `apps/<name>/config.sh` — set `APP_NAME`, `APP_REPO`, `APP_CLEAN_SHA` (a commit SHA from the upstream repo; no fork required), `APP_OTEL_AGENT_TYPE`, and define `cmd_build()`, `cmd_start()` (and optionally `cmd_bootstrap()`, `cmd_status()`)
3. Create `apps/<name>/traffic.sh` — standalone script that generates traffic against the running app
4. Create `apps/<name>/instrument-preamble.md` — app-specific intro injected before the skill content; use `%REPO_DIR%`, `%API_KEY%`, `%OTLP_ENDPOINT%`, `%APP_DATASET%` as substitution placeholders
5. Create `apps/<name>/EVALUATION.md` — evaluation checklist for verifying instrumentation quality
6. Run `./harness.sh <name> download` to clone the repo
