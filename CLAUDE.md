# OTel Skill Test Harness

This project exists to repeatedly test Claude's OpenTelemetry instrumentation skills against real application codebases in various languages and frameworks.

## Structure

```
run.ts                # Full-run orchestrator: reset → build → instrument → start → traffic → evaluate
src/
  instrumentation.ts  # Agent SDK runner — calls the instrumentation agent via @anthropic-ai/claude-agent-sdk
  evaluation.ts       # Honeycomb query-based evaluation criteria
  harness.ts          # Helpers that wrap harness.sh commands
  metrics.ts          # Run record persistence (runs.jsonl) and summary printing
harness.sh            # Low-level step runner: reset, build, bootstrap, start, stop, traffic, instrument
broadleaf.sh          # Thin wrapper: ./broadleaf.sh <cmd> → ./harness.sh broadleaf <cmd>
apps/
  broadleaf/          # Broadleaf Commerce DemoSite (Java/Spring Boot)
    config.sh         # App-specific variables and start/stop/build hooks
    traffic.sh        # Traffic generation script
    instrument-preamble.md  # App-specific intro injected into the agent prompt
    EVALUATION.md     # Evaluation checklist for this app
checkouts/
  broadleaf/          # Cloned app code (gitignored)
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
file (`.harness.<app>.pids`), and prompt (`.instrument-prompt.<app>.md`), and a
distinct default port (broadleaf 8080/8443, realworld-go 8090, beaverhabits 9001)
so concurrent runs don't collide. Per-app ports are set in `apps/<app>/config.sh`
via `APP_HTTP_PORT` (broadleaf also `APP_HTTPS_PORT`/`APP_ADMIN_HTTP_PORT`/`APP_ADMIN_HTTPS_PORT`).

This orchestrates the complete cycle automatically:

1. `reset --purge` — discard the current scratch branch and create a fresh `scratch_YYYY-MM-DD` branch from `clean`
2. `build` — build all modules
3. `bootstrap` — seed the HSQLDB schema (skipped automatically if already seeded)
4. `instrument` — generate `.instrument-prompt.<app>.md` from the skill content + app preamble
5. Agent SDK run — `src/instrumentation.ts` drives a clean-context agent via `@anthropic-ai/claude-agent-sdk` with the prompt, no conversation history
6. `start` — start site (HTTP 8080 / HTTPS 8443) and admin (HTTP 8081 / HTTPS 8444); ports configurable via `APP_*_PORT`
7. `traffic` — generate representative traffic across key paths
8. Evaluate — `src/evaluation.ts` queries Honeycomb and checks pass/fail criteria
9. Record — results appended to `runs.jsonl`

> **Note on bootstrap:** The embedded HSQLDB stores its files under `/tmp/broadleaf-hsqldb`. These survive normal session restarts but are cleared on system reboot. If `start` fails with a schema-related error, run `./broadleaf.sh bootstrap` manually before re-running.

## harness.sh — Individual Steps

`harness.sh` (and the `broadleaf.sh` wrapper) expose each step individually for debugging. `run.ts` calls these internally; you rarely need to invoke them directly. Two env vars are required: `OTEL_EXPORTER_OTLP_HEADERS` (ingest key) and `HONEYCOMB_QUERY_API_KEY` (query key with Query Data permission) — both read from `.env`.

## Key facts (Broadleaf)

- **DemoSite** is a Maven multi-module Spring Boot app (Spring Boot 2.7.x, Java 17+)
- Modules: `core`, `site` (port 8080), `admin` (port 8081), `api` (port 8082)
- App code lives at: `checkouts/broadleaf/`
- Default database: embedded HSQLDB — no external services needed
- The `clean` branch in the fork (`evanderkoogh/broadleaf-demosite`) is the unmodified upstream baseline; never commit instrumentation changes there
- Scratch branches (`scratch_YYYY-MM-DD[-N]`) are the working branches for each test run

## Running the DemoSite (manual steps)

Use `broadleaf.sh` (or `harness.sh broadleaf`) to run individual steps — never invoke Maven or Java directly:

- `./broadleaf.sh download` — clone the DemoSite repo (skips if already present)
- `./broadleaf.sh download-agent` — download the OTel Java agent jar to `otel/`
- `./broadleaf.sh build` — build all modules (skips tests)
- `./broadleaf.sh bootstrap` — seed HSQLDB schema (once after build or system reboot)
- `./broadleaf.sh instrument` — generate `.instrument-prompt.<app>.md` (used internally by `run.ts`)
- `./broadleaf.sh start` — start site (HTTP 8080 / HTTPS 8443) and admin (HTTP 8081 / HTTPS 8444) in the background
- `./broadleaf.sh stop` — stop running servers
- `./broadleaf.sh restart` — stop, clean logs, then start
- `./broadleaf.sh status` — check whether servers are running
- `./broadleaf.sh traffic` — generate representative traffic across key site paths
- `./broadleaf.sh clean` — remove logs and Playwright session artifacts

## Browsing the DemoSite

Use the **Playwright MCP** tools (`playwright_navigate`, `playwright_screenshot`, etc.) when interacting with the running demo. Do not use `curl`, `WebFetch`, or raw HTTP calls to browse or verify UI behavior.

## Constraints

**All OpenTelemetry instrumentation changes must be made inside `checkouts/broadleaf/` only.** The root-level directory and `apps/broadleaf/` config files are the test harness and must never be modified as part of an instrumentation task. If an instrumentation skill tries to create or edit files outside `checkouts/broadleaf/`, that is a mistake.

## Adding a new app

1. `mkdir apps/<name>`
2. Create `apps/<name>/config.sh` — set `APP_NAME`, `APP_REPO`, `APP_CLEAN_SHA` (a commit SHA from the upstream repo; no fork required), `APP_OTEL_AGENT_TYPE`, and define `cmd_build()`, `cmd_start()` (and optionally `cmd_bootstrap()`, `cmd_status()`)
3. Create `apps/<name>/traffic.sh` — standalone script that generates traffic against the running app
4. Create `apps/<name>/instrument-preamble.md` — app-specific intro injected before the skill content; use `%REPO_DIR%`, `%API_KEY%`, `%OTLP_ENDPOINT%`, `%APP_DATASET%` as substitution placeholders
5. Create `apps/<name>/EVALUATION.md` — evaluation checklist for verifying instrumentation quality
6. Run `./harness.sh <name> download` to clone the repo
