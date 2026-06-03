# Broadleaf OTel Skill Test Harness

This project exists to repeatedly test Claude's OpenTelemetry instrumentation skills against a real Java/Spring Boot codebase.

## Purpose

Each session simulates a fresh instrumentation engagement on the Broadleaf Commerce DemoSite. The scripts in this repo exist to quickly reset the DemoSite to a clean, pre-instrumentation state so the same skill can be re-tested without leftover changes from a previous run.

## Workflow

1. `./broadleaf.sh reset --purge` — discard the current scratch branch (local + remote) and create a fresh `scratch_YYYY-MM-DD` branch from the `clean` baseline
2. `./broadleaf.sh build` — build all modules
3. `./broadleaf.sh bootstrap` — seed the HSQLDB schema (required on first run and after `/tmp` is cleared, e.g. after a system restart; skipped automatically if already seeded)
4. Invoke the OTel instrumentation skill and apply changes to `DemoSite/`
5. Write `DemoSite/.skill-version` with the skill repo branch and short SHA, and write `DemoSite/INSTRUMENTATION.md` recording the skill version and the prompt that triggered this session
6. `./broadleaf.sh start` — start site and admin; verify telemetry is flowing
6. Repeat from step 1

> **Note on bootstrap:** The embedded HSQLDB stores its files under `/tmp/broadleaf-hsqldb`. These survive normal session restarts but are cleared on system reboot. `bootstrap` seeds the schema via `mvn spring-boot:run` once so subsequent `start` commands can use the faster `java -cp` (exploded JAR) path. If `start` fails with a schema-related error, run `bootstrap` again.

## Key facts

- **DemoSite** is a Maven multi-module Spring Boot app (Spring Boot 2.7.x, Java 17+)
- Modules: `core`, `site` (port 8080), `admin` (port 8081), `api` (port 8082)
- Default database: embedded HSQLDB — no external services needed
- The `clean` branch in the fork (`evanderkoogh/broadleaf-demosite`) is the unmodified upstream baseline; never commit instrumentation changes there
- Scratch branches (`scratch_YYYY-MM-DD[-N]`) are the working branches for each test run

## Running the DemoSite

Always use `broadleaf.sh` to manage the DemoSite — never invoke Maven or Java directly:

- `./broadleaf.sh build` — build all modules (skips tests)
- `./broadleaf.sh bootstrap` — seed HSQLDB schema (once after build or system reboot)
- `./broadleaf.sh start` — start site (port 8080) and admin (port 8081) in the background
- `./broadleaf.sh stop` — stop running servers
- `./broadleaf.sh restart` — stop, clean logs, then start
- `./broadleaf.sh status` — check whether servers are running
- `./broadleaf.sh clean` — remove logs and Playwright session artifacts

## Browsing the DemoSite

Use the **Playwright MCP** tools (`playwright_navigate`, `playwright_screenshot`, etc.) when interacting with the running demo. Do not use `curl`, `WebFetch`, or raw HTTP calls to browse or verify UI behavior.

## Constraints

**All OpenTelemetry instrumentation changes must be made inside `DemoSite/` only.** The root-level directory is the test harness and must never be modified as part of an instrumentation task. If an instrumentation skill tries to create or edit files outside `DemoSite/`, that is a mistake.
