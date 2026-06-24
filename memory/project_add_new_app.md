---
name: project-add-new-app
description: Step-by-step instructions for adding a new application to the OTel skill test harness
metadata:
  type: project
---

## Adding a new app to the harness

No fork required. Point directly at the upstream repo + a pinned commit SHA.

### 1. Create `apps/<name>/config.sh`

Minimum required fields:

```bash
APP_NAME="myapp"
APP_REPO="https://github.com/org/repo.git"
APP_CLEAN_SHA="<full 40-char SHA from upstream>"
APP_HTTP_PORT=8080           # MUST be unique across apps — parallel runs share the host (see ports note below)
APP_OTEL_AGENT_TYPE="java"   # or "python", "node", "none"
APP_DATASET="myapp"          # Honeycomb dataset name == the service.name the instrumentation must emit

cmd_build() { ... }   # required
cmd_start() { ... }   # required
# cmd_bootstrap() { ... }   # optional — one-time DB seed etc.
# cmd_setup() { ... }       # optional — copy baseline files into checkout after clone/reset
```

`cmd_start()` must wait for the server to be ready (poll a log file or health endpoint) before returning, and write the PID to `$PID_FILE`.

**Parallel-safe by design:** `LOG_DIR` (`logs/<app>/`), `PID_FILE` (`.harness.<app>.pids`), and the prompt (`.instrument-prompt.<app>.md`) are all app-scoped, and the checkout is per-app — so `npx tsx run.ts <a> <b> --parallel` runs apps concurrently. The one thing the harness can't isolate is host ports: give every app a unique `APP_HTTP_PORT` (and any other listener). Current assignments: broadleaf 8080/8443 + admin 8081/8444, realworld-go 8090, beaverhabits 9001. `cmd_start` should reference these vars (not literals) and `traffic.sh` reads exported `APP_HTTP_PORT`/`APP_HTTPS_PORT`.

### 2. If baseline files are needed: `apps/<name>/files/`

For apps where the upstream repo is missing harness-required files (e.g. custom start scripts for Java), store those files in `apps/<name>/files/` and add a `cmd_setup()` that copies them in:

```bash
cmd_setup() {
  cp "$APP_DIR/files/start.sh" "$REPO_DIR/start.sh"
  chmod +x "$REPO_DIR/start.sh"
}
```

`harness_download` and `harness_reset` both call `cmd_setup()` automatically if defined.

### 3. Create `apps/<name>/traffic.sh`

Standalone script that generates representative HTTP traffic. The harness calls it after the app starts. Curl all key routes. Must not block — fire all requests and exit.

### 4. Set the `APP_*` fact vars in `config.sh` (no per-app preamble file)

There are **no per-app `instrument-preamble.md` files**. The agent prompt is one preamble rendered
from a shared, user-voice template (`instrument-preamble.template.md` at the repo root) filled with
each app's `APP_*` facts. So put the app facts in `config.sh`:

`APP_DATASET` (service name), `APP_DESCRIPTION`, `APP_LANGUAGE`, `APP_FRAMEWORKS`, `APP_CODE_LOCATION`,
`APP_BUILD_HINT`, `APP_START_HINT`, `APP_ENV_SURFACE`, `APP_READINESS`, and optionally `APP_STOP_HINT`,
`APP_ATTR_NAMING`, `APP_WEAVER_REGISTRY`, `APP_IMPORT_REGISTRIES`. Anything you omit falls back to a
sensible default in `harness.sh`.

Keep these to **plain app facts only — no instrumentation how-to** (that lives in the skill; see
[[feedback-no-preamble-edits]]). The template is written in the voice of a user who just wants their
app instrumented — no conductor/orchestration mechanics.

The harness intentionally does **not** set `OTEL_SERVICE_NAME` — the instrumentation skill must set
`service.name` itself. The template tells the agent to use `APP_DATASET` as the service name so traces
land in the matching Honeycomb dataset; the `service_name` criterion (`src/evaluation.ts`) fails if
`service.name` is absent or left at `unknown_service`.

**Gotcha:** don't put em-dashes or apostrophes inside a `${VAR:-default}` default in `harness.sh` —
macOS bash 3.2 mis-parses them (use ASCII `-` and avoid apostrophes in those defaults).

### 5. Create `apps/<name>/EVALUATION.md`

App-specific evaluation checklist. The harness evaluation criteria are coded in `src/evaluation.ts` — this file is for human reference.

### 6. Download the repo

```bash
./harness.sh <name> download
```

---

## Language-specific callouts

**New language/runtime? Check the implementer skill has a guide for it.** The
`otel-instrumentation-implementation` skill keeps an *explicit list* of languages that have a
dedicated `references/<language>.md` guide (currently Go, Java/JVM, Python) and says that guide
takes precedence over the skill's generic steps. If the new app's language/runtime is **not** in
that list, decide whether to author a `references/<language>.md` guide and add it to the list in
`agent-skill/honeycomb/skills/otel-instrumentation-implementation/SKILL.md` — the list is a
maintenance point that won't update itself. See [[project-goal-portable-skills]].

### Java / Spring Boot

- The upstream repo likely lacks start scripts. Create `apps/<name>/files/start-site.sh` (and `-admin.sh` if needed) and install via `cmd_setup()`.
- Start scripts must use the **exploded JAR** pattern (`jar -xf` + `-cp EXPLODED/...`) NOT `java -jar`, due to Spring LTW requirements.
- Add `OTEL_BSP_MAX_QUEUE_SIZE=10000` in the start script. The default 2048 overflows during Spring Boot startup (Hibernate, Solr, etc.), causing Tomcat root spans to be dropped and rootless traces in Honeycomb. See [[project-broadleaf-startup]].
- `build` runs `mvn clean install -DskipTests`. Maven dep resolution is handled by the harness.

### Python (uv)

- `build` runs `uv sync`, which creates `.venv` and installs base deps.
- Note the existing `.venv` in `APP_BUILD_HINT` so the agent doesn't re-run `uv sync` (~2 min wasted per run) — e.g. "uv sync — a .venv with base dependencies already exists, so prefer 'uv add <pkg>' for new packages rather than re-syncing".
- The agent is expected to `uv add` the OTel packages (that IS part of what's being tested).

### Node.js

- No known special cases yet.

---

## Prompt assembly (applies to all apps)

There is one shared template (`instrument-preamble.template.md`) rendered per app from `config.sh`
`APP_*` vars — so any cross-app framing (fresh-engagement note, "changes inside the repo only",
"verify before finishing") lives in that single template, not duplicated per app. To change framing
for all apps, edit the template; to change one app's facts, edit its `config.sh`.
