# OTel Skill Test Harness

This project exists to repeatedly test Claude's OpenTelemetry instrumentation skills against real application codebases in various languages and frameworks.

## Structure

```
apps/
  broadleaf/          # Broadleaf Commerce DemoSite (Java/Spring Boot)
    config.sh         # App-specific variables and start/stop/build hooks
    traffic.sh        # Traffic generation script
    instrument-preamble.md  # App-specific intro injected into the agent prompt
    EVALUATION.md     # Evaluation checklist for this app
    DemoSite/         # Cloned app code (gitignored)
harness.sh            # Main orchestration: ./harness.sh <app> <command>
broadleaf.sh          # Thin wrapper: ./broadleaf.sh <cmd> → ./harness.sh broadleaf <cmd>
```

To add a new app, create `apps/<name>/` with `config.sh`, `traffic.sh`, `instrument-preamble.md`, and `EVALUATION.md`. No changes to shared harness code required.

## Purpose

Each session simulates a fresh instrumentation engagement on a target application. The scripts in this repo exist to quickly reset the target to a clean, pre-instrumentation state so the same skill can be re-tested without leftover changes from a previous run.

## Workflow

1. `./broadleaf.sh reset --purge` — discard the current scratch branch (local + remote) and create a fresh `scratch_YYYY-MM-DD` branch from the `clean` baseline
2. `./broadleaf.sh build` — build all modules
3. `./broadleaf.sh bootstrap` — seed the HSQLDB schema (required on first run and after `/tmp` is cleared, e.g. after a system restart; skipped automatically if already seeded)
4. `./broadleaf.sh instrument` — generate `.instrument-prompt.md`, then spawn a clean-context `Agent` with that prompt (see **Applying OTel Instrumentation** below)
5. Write `apps/broadleaf/DemoSite/.skill-version` and `apps/broadleaf/DemoSite/INSTRUMENTATION.md` (see below)
6. `./broadleaf.sh start` — start site and admin
7. `./broadleaf.sh traffic` — generate representative traffic across key paths
8. Evaluate against `apps/broadleaf/EVALUATION.md` using Honeycomb queries
9. Repeat from step 1

> **Note on bootstrap:** The embedded HSQLDB stores its files under `/tmp/broadleaf-hsqldb`. These survive normal session restarts but are cleared on system reboot. `bootstrap` seeds the schema via `mvn spring-boot:run` once so subsequent `start` commands can use the faster `java -cp` (exploded JAR) path. If `start` fails with a schema-related error, run `bootstrap` again.

## Applying OTel Instrumentation (Clean-Context Agent)

**Never use the `Skill` tool inline for instrumentation.** It runs with full conversation context, which defeats the purpose of testing the skill in isolation.

Instead:

1. Run `./broadleaf.sh instrument` — this generates `.instrument-prompt.md` with the full skill content (resolving `${CLAUDE_PLUGIN_ROOT}`) and the API key from `.env`
2. Read `.instrument-prompt.md`
3. Spawn an `Agent` using that content as the prompt

The agent starts with no conversation history and no accumulated session knowledge — only what the skill says and its base training.

## Key facts (Broadleaf)

- **DemoSite** is a Maven multi-module Spring Boot app (Spring Boot 2.7.x, Java 17+)
- Modules: `core`, `site` (port 8080), `admin` (port 8081), `api` (port 8082)
- App code lives at: `apps/broadleaf/DemoSite/`
- Default database: embedded HSQLDB — no external services needed
- The `clean` branch in the fork (`evanderkoogh/broadleaf-demosite`) is the unmodified upstream baseline; never commit instrumentation changes there
- Scratch branches (`scratch_YYYY-MM-DD[-N]`) are the working branches for each test run

## Running the DemoSite

Always use `broadleaf.sh` (or `harness.sh broadleaf`) to manage the DemoSite — never invoke Maven or Java directly:

- `./broadleaf.sh download` — clone the DemoSite repo (skips if already present)
- `./broadleaf.sh download-agent` — download the OTel Java agent jar to `otel/`
- `./broadleaf.sh build` — build all modules (skips tests)
- `./broadleaf.sh bootstrap` — seed HSQLDB schema (once after build or system reboot)
- `./broadleaf.sh instrument` — generate `.instrument-prompt.md` for clean-context agent
- `./broadleaf.sh start` — start site (port 8080) and admin (port 8081) in the background
- `./broadleaf.sh stop` — stop running servers
- `./broadleaf.sh restart` — stop, clean logs, then start
- `./broadleaf.sh status` — check whether servers are running
- `./broadleaf.sh traffic` — generate representative traffic across key site paths
- `./broadleaf.sh clean` — remove logs and Playwright session artifacts

## Browsing the DemoSite

Use the **Playwright MCP** tools (`playwright_navigate`, `playwright_screenshot`, etc.) when interacting with the running demo. Do not use `curl`, `WebFetch`, or raw HTTP calls to browse or verify UI behavior.

## Constraints

**All OpenTelemetry instrumentation changes must be made inside `apps/broadleaf/DemoSite/` only.** The root-level directory and `apps/broadleaf/` config files are the test harness and must never be modified as part of an instrumentation task. If an instrumentation skill tries to create or edit files outside `apps/broadleaf/DemoSite/`, that is a mistake.

## Adding a new app

1. `mkdir apps/<name>`
2. Create `apps/<name>/config.sh` — set `APP_NAME`, `APP_REPO`, `APP_CLEAN_BRANCH`, `APP_OTEL_AGENT_TYPE`, and define `cmd_build()`, `cmd_start()` (and optionally `cmd_bootstrap()`, `cmd_status()`)
3. Create `apps/<name>/traffic.sh` — standalone script that generates traffic against the running app
4. Create `apps/<name>/instrument-preamble.md` — app-specific intro injected before the skill content; use `%REPO_DIR%`, `%API_KEY%`, `%OTLP_ENDPOINT%` as substitution placeholders
5. Create `apps/<name>/EVALUATION.md` — evaluation checklist for verifying instrumentation quality
6. Run `./harness.sh <name> download` to clone the repo
