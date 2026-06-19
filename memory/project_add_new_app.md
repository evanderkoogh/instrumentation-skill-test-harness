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

### 4. Create `apps/<name>/instrument-preamble.md`

Injected before the skill content in the agent prompt. Keep it short. Standard boilerplate:

```markdown
You are applying OpenTelemetry instrumentation to <AppName> — <one-line description>.
```

Use `%REPO_DIR%`, `%API_KEY%`, `%OTLP_ENDPOINT%`, `%APP_DATASET%` as substitution placeholders.

The harness intentionally does **not** set `OTEL_SERVICE_NAME` — the instrumentation skill is responsible for setting `service.name`. So the preamble must pin it for the harness to find the data: add a line telling the agent to use `%APP_DATASET%` as the service name (`service.name` / `OTEL_SERVICE_NAME`) so traces land in the matching Honeycomb dataset. The `service_name` evaluation criterion (in `src/evaluation.ts`) fails if `service.name` is absent or left at the OTel default (`unknown_service`).

### 5. Create `apps/<name>/EVALUATION.md`

App-specific evaluation checklist. The harness evaluation criteria are coded in `src/evaluation.ts` — this file is for human reference.

### 6. Download the repo

```bash
./harness.sh <name> download
```

---

## Language-specific callouts

### Java / Spring Boot

- The upstream repo likely lacks start scripts. Create `apps/<name>/files/start-site.sh` (and `-admin.sh` if needed) and install via `cmd_setup()`.
- Start scripts must use the **exploded JAR** pattern (`jar -xf` + `-cp EXPLODED/...`) NOT `java -jar`, due to Spring LTW requirements.
- Add `OTEL_BSP_MAX_QUEUE_SIZE=10000` in the start script. The default 2048 overflows during Spring Boot startup (Hibernate, Solr, etc.), causing Tomcat root spans to be dropped and rootless traces in Honeycomb. See [[project-broadleaf-startup]].
- `build` runs `mvn clean install -DskipTests`. Maven dep resolution is handled by the harness.

### Python (uv)

- `build` runs `uv sync`, which creates `.venv` and installs base deps.
- Add this to `instrument-preamble.md` to avoid the agent re-running `uv sync` (~2 min wasted per run):
  > A virtual environment already exists at %REPO_DIR%/.venv with base dependencies installed. Do not run `uv sync` — use `uv add` to install any additional packages you need.
- The agent is expected to `uv add` the OTel packages (that IS part of what's being tested).

### Node.js

- No known special cases yet.

---

## Preamble gotcha (applies to all apps)

The **global** `instrument-preamble.md` (repo root) already tells the agent not to start the app or verify spans. Do NOT add that to individual app preambles — the global one covers it.

**Why:** When the skill is used outside the harness, starting the app and verifying spans IS the right behavior. The harness-specific instruction only belongs in the harness global preamble.
