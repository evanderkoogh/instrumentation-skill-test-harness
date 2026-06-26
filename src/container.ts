// Host-side launcher for the containerized instrumentation agent (HARNESS_CONTAINERIZE=1).
//
// Runs the agent step (otherwise the in-process runInstrumentation() call at run.ts) inside a Docker
// container so the agent's Bash — `ps`/`lsof`/`kill`, its own weaver live-check, its app starts — sees
// only its own PID + network namespace, never the harness's scoring weaver/collector or sibling
// --parallel runs. Everything else (build / start / traffic / evaluate / score) stays on the host.
//
// The image (docker/agent-python.Dockerfile) bakes the harness code at /harness; here we bind-mount
// the checkout, tmp/, and the skill tree at the matching in-container paths so src/instrumentation.ts
// and src/sandbox.ts resolve paths exactly as they do on the host, unchanged. Metrics come back via
// the bind-mounted tmp/.agent-metrics.<app>.json that src/run-agent.ts writes.
import { spawn } from "node:child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, cpSync } from "fs";
import { homedir, tmpdir } from "os";
import type { AgentMetrics, SkillVersion } from "./instrumentation.js";
import type { FullEvaluation } from "./evaluation.js";
import { readAppConfig, StartupFailure } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, "..");

// Where the harness code is baked in the image — must match WORKDIR in the Dockerfiles so the
// bind-mount paths line up with runInstrumentation's path resolution.
const CONTAINER_ROOT = "/harness";

// Pick the per-language agent image from the app's APP_OTEL_AGENT_TYPE (python|go|java|node), built
// from docker/agent-<lang>.Dockerfile. HARNESS_AGENT_IMAGE overrides as an escape hatch.
// (build: docker build -f docker/agent-base.Dockerfile -t harness-agent-base . ; then the language image.)
function imageFor(app: string): string {
  if (process.env.HARNESS_AGENT_IMAGE) return process.env.HARNESS_AGENT_IMAGE;
  const { language } = readAppConfig(app);
  return `harness-agent-${language}`;
}

// Broadleaf's SolrServer auto-config downloads a full standalone Solr (~225 MB) from the
// rate-limited archive.apache.org on first boot, into `${java.io.tmpdir}/solr-<version>` (its
// `solr.server.working-directory` default), and skips the download when that dir already exists.
// java.io.tmpdir differs by OS: on the macOS host it's the per-user $TMPDIR (≈ os.tmpdir(), e.g.
// /var/folders/.../T) where the harness's many prior host runs already cached it; inside the Linux
// container it's /tmp. So bind the host's existing cache (os.tmpdir()/solr-<ver>) through to the
// container's path — no re-download, and shared with the host-side scoring boot. Version-pinned to
// Broadleaf's bundled Solr (the app is pinned to APP_CLEAN_SHA, so this is stable).
const SOLR_DIR_NAME = "solr-8.11.3";
const CONTAINER_SOLR_DIR = `/tmp/${SOLR_DIR_NAME}`; // Linux java.io.tmpdir/solr-<ver>
const hostSolrDir = (): string => resolve(tmpdir(), SOLR_DIR_NAME); // macOS java.io.tmpdir/solr-<ver>

// Durable, known-good Solr copy. The os.tmpdir() cache above is volatile (a reboot clears it) and
// fragile (a run killed mid-download leaves a partial .tgz + half extraction, which Broadleaf treats
// as absent and re-downloads — ~25 min on the throttled archive.apache.org mirror, looking like a
// hung startup). So keep the verified tree alongside the other downloaded tooling in the gitignored
// otel/ tree and self-heal the volatile cache from it. See memory: project-solr-known-good-cache.
const DURABLE_SOLR_DIR = resolve(harnessRoot, "otel", SOLR_DIR_NAME);

// A complete cache holds the tgz extracted into a nested solr-<ver>/ dir (Broadleaf extracts the
// archive, whose top-level entry is solr-<ver>/, into the cache root — so the launch script lands at
// <cacheDir>/solr-<ver>/bin/solr). A complete extraction has both the launch script and the server
// bootstrap jar; a partial download / interrupted extraction has neither. Used as the integrity
// marker so a half-trusted cache is treated as absent and reseeded rather than booted against.
function solrCacheComplete(cacheDir: string): boolean {
  const root = resolve(cacheDir, SOLR_DIR_NAME);
  return existsSync(resolve(root, "bin", "solr")) && existsSync(resolve(root, "server", "start.jar"));
}

// Make broadleaf's Solr cache robust to killed/parallel runs and reboots. Runs host-side before each
// broadleaf container launch (the boot that triggers the download happens inside the container, which
// bind-mounts hostSolrDir() → CONTAINER_SOLR_DIR):
//   - durable good + run cache missing/corrupt → reseed the run cache from the durable copy (self-heal)
//   - durable absent + run cache good          → capture it as the durable known-good copy
//   - neither good                             → leave it; Broadleaf downloads on first boot (slow path,
//                                                 once per machine — captured durably on the next launch)
// The ~225 MB copy only runs on the rare corrupt/first-good transition, never in the steady state.
function ensureSolrCache(): void {
  const runDir = hostSolrDir();
  const durableGood = solrCacheComplete(DURABLE_SOLR_DIR);
  const runGood = solrCacheComplete(runDir);

  if (durableGood && !runGood) {
    console.error(`[solr-cache] ${runDir} missing/corrupt — reseeding from durable ${DURABLE_SOLR_DIR}`);
    rmSync(runDir, { recursive: true, force: true });
    cpSync(DURABLE_SOLR_DIR, runDir, { recursive: true });
  } else if (!durableGood && runGood) {
    console.error(`[solr-cache] capturing known-good ${runDir} → durable ${DURABLE_SOLR_DIR}`);
    rmSync(DURABLE_SOLR_DIR, { recursive: true, force: true });
    cpSync(runDir, DURABLE_SOLR_DIR, { recursive: true });
  }
  // Always leave a host-owned run-cache dir for the bind mount, even on the cold first-boot path.
  mkdirSync(runDir, { recursive: true });
}

// Extra `docker run` args some apps/languages need on top of the standard mounts. Kept narrow so the
// isolation story stays intact:
//  - java: bind the host ~/.m2 cache (RW) into the container's HOME so Maven reuses ~1 GB of deps
//    instead of re-downloading them every broadleaf run. (The JVM's `user.home` — which Maven uses to
//    locate ~/.m2 — now resolves to containerHome on its own, because passwdMountArgs gives the run uid
//    a real /etc/passwd entry whose home field is containerHome; no -Duser.home override is needed.)
//  - broadleaf: bind the host-seeded HSQLDB (`harness.sh broadleaf bootstrap` writes it to
//    /tmp/broadleaf-hsqldb, a Broadleaf framework default) at the same path inside the container's
//    isolated /tmp, so the agent's verification boot finds the correct schema; and the Solr cache
//    dir (see BROADLEAF_SOLR_DIR) so the 225 MB Solr download is reused, not repeated every run.
function extraDockerArgs(app: string, language: string, containerHome: string): string[] {
  const args: string[] = [];
  if (language === "java") {
    args.push("-v", `${resolve(homedir(), ".m2")}:${containerHome}/.m2`);
  }
  if (app === "broadleaf") {
    args.push("-v", "/tmp/broadleaf-hsqldb:/tmp/broadleaf-hsqldb");
    args.push("-v", `${hostSolrDir()}:${CONTAINER_SOLR_DIR}`);
  }
  return args;
}

// Both container launches run with `--user <host-uid>:<host-gid>`, and the base image has no
// /etc/passwd entry for that (run-time-only) uid. Any program that resolves the current OS user then
// fails — notably Go's standard `resource.WithProcess()` → `os/user.Current()`, whose error aborts
// OTel init so the app emits ZERO spans and the verifier reports a false FAIL. (It also gives the JVM a
// real `user.home`, which is why the java path no longer needs a -Duser.home override; see
// extraDockerArgs.) Generate a minimal passwd/group pair for the exact run uid and bind-mount them
// read-only — language-agnostic, works for
// an arbitrary host uid, and (like the Java fix) lives in the docker args so no image rebuild is
// needed. The host uid is stable, so a single shared tmp/.passwd is fine even under --parallel
// (every run writes identical content). Replaces the image's stock passwd, which is safe here: the
// container only ever runs as the host uid, never the image's build-time/system accounts.
function passwdMountArgs(uid: number, gid: number, containerHome: string): string[] {
  const passwdFile = resolve(harnessRoot, "tmp", ".passwd");
  const groupFile = resolve(harnessRoot, "tmp", ".group");
  writeFileSync(
    passwdFile,
    `root:x:0:0:root:/root:/bin/bash\nagent:x:${uid}:${gid}:agent:${containerHome}:/bin/sh\n`
  );
  writeFileSync(groupFile, `root:x:0:\nagent:x:${gid}:\n`);
  return ["-v", `${passwdFile}:/etc/passwd:ro`, "-v", `${groupFile}:/etc/group:ro`];
}

// Secrets are forwarded by NAME (`-e KEY`, no value) so they never land on the docker argv /
// `docker inspect`; the value comes from the spawned process's env.
const SECRET_ENV = [
  "HARNESS_INGEST_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  // The verifier sub-agent queries Honeycomb via the (key-authed) Honeycomb MCP configured in
  // instrumentation.ts; forward only the MCP management key (<KEY_ID>:<SECRET_KEY>). We deliberately
  // do NOT forward HONEYCOMB_QUERY_API_KEY here: with no REST query key in the container, the verifier
  // can't hand-roll `curl` queries (it must use the MCP), and the key never lands in the agent's logs
  // or telemetry. (The lifecycle step forwards HONEYCOMB_QUERY_API_KEY separately for run-eval.)
  "HONEYCOMB_MCP_KEY",
];

export async function runInstrumentationInContainer(
  app: string,
  ingestKey: string,
  runId: string,
  collectorEndpoint: string | undefined,
  model: string | undefined,
  skill: SkillVersion
): Promise<AgentMetrics> {
  const metricsFile = resolve(harnessRoot, "tmp", `.agent-metrics.${app}.json`);
  rmSync(metricsFile, { force: true }); // never read a stale prior-run file

  // The host agent-collector binds 0.0.0.0 under HARNESS_CONTAINERIZE (see harness.sh); from the
  // container the host is host.docker.internal. Rewrite only the host part, keep the port.
  const containerEndpoint = collectorEndpoint?.replace(
    /\/\/(127\.0\.0\.1|localhost)\b/,
    "//host.docker.internal"
  );

  const checkoutDir = resolve(harnessRoot, "checkouts", app);
  const tmpDir = resolve(harnessRoot, "tmp");
  // `agent-skill` is a symlink in the harness root; docker resolves it to the real dir for the mount.
  const skillDir = resolve(harnessRoot, "agent-skill", "honeycomb");

  const { language } = readAppConfig(app);
  const image = imageFor(app);
  // `docker run --user <uid>` leaves the container with no home dir, so Go (GOPATH/GOCACHE), Maven
  // (~/.m2), and uv have nowhere writable. Mount a per-app, host-uid-owned dir as HOME — but at a
  // path OUTSIDE /harness. The agent's sandbox (src/sandbox.ts) blocks reads inside the harness tree
  // that aren't the checkout or otel/, so a HOME under /harness/tmp would make the agent's OWN
  // dependency cache (GOPATH, ~/.m2 source) unreadable — exactly what it needs to look up library
  // symbols/semconv. Outside /harness it's allowed (matching host behaviour, where dep caches sit in
  // the real $HOME). Persisted host-side under tmp/ (gitignored) so caches survive across runs.
  const containerHome = "/home/agent";
  const hostHomeDir = resolve(tmpDir, `.home-${app}`);
  // Pre-create host-side so it's owned by the host uid; otherwise docker creates the mount point as
  // root and the --user agent can't write HOME (.cache, .config, GOPATH, …).
  mkdirSync(hostHomeDir, { recursive: true });
  // Seed/self-heal broadleaf's Solr cache from the durable known-good copy (and capture the first good
  // copy back to it), leaving a host-owned run-cache dir for the bind mount. (See ensureSolrCache.)
  if (app === "broadleaf") ensureSolrCache();

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const args = [
    "run",
    "--rm",
    // Named so `run.ts kill <app>` can `docker stop` a detached container (a killed run process
    // doesn't reap the `docker run` container itself).
    "--name",
    `harness-agent-${app}`,
    // Write checkout edits as the host user so the subsequent host-side build/git stay clean.
    "--user",
    `${uid}:${gid}`,
    // Give the run uid a real /etc/passwd entry (no-passwd --user breaks os/user.Current() → OTel init).
    ...passwdMountArgs(uid, gid, containerHome),
    "--add-host",
    "host.docker.internal:host-gateway",
    // Mounts — paths mirror the in-image /harness layout so instrumentation.ts resolves unchanged.
    "-v",
    `${checkoutDir}:${CONTAINER_ROOT}/checkouts/${app}`,
    "-v",
    `${tmpDir}:${CONTAINER_ROOT}/tmp`,
    "-v",
    `${skillDir}:${CONTAINER_ROOT}/agent-skill/honeycomb:ro`,
    // HOME — mounted outside /harness so the agent can read its own dep caches (see containerHome).
    "-v",
    `${hostHomeDir}:${containerHome}`,
    // Per-language / per-app extra mounts (java ~/.m2 cache, broadleaf seeded HSQLDB).
    ...extraDockerArgs(app, language, containerHome),
    // Writable HOME for in-container Go/Maven/uv caches (see containerHome above).
    "-e",
    `HOME=${containerHome}`,
    // Non-secret run config (safe to appear on the argv).
    "-e",
    `HARNESS_RUN_ID=${runId}`,
    ...(containerEndpoint ? ["-e", `HARNESS_COLLECTOR_ENDPOINT=${containerEndpoint}`] : []),
    ...(model ? ["-e", `HARNESS_MODEL=${model}`] : []),
    "-e",
    `HARNESS_SKILL_BRANCH=${skill.branch}`,
    "-e",
    `HARNESS_SKILL_SHA=${skill.sha}`,
    "-e",
    `HARNESS_SKILL_COMMIT=${skill.commit}`,
    "-e",
    `HARNESS_SKILL_CONTENT_HASH=${skill.contentHash}`,
    "-e",
    `HARNESS_SKILL_UNCOMMITTED=${skill.uncommitted}`,
    ...(skill.description ? ["-e", `HARNESS_SKILL_DESCRIPTION=${skill.description}`] : []),
    // Secrets — forwarded by name only.
    ...SECRET_ENV.flatMap((k) => ["-e", k]),
    image,
    app,
  ];

  const childEnv = { ...process.env, HARNESS_INGEST_KEY: ingestKey };

  await new Promise<void>((res, rej) => {
    const child = spawn("docker", args, { stdio: "inherit", env: childEnv });
    child.on("error", rej);
    child.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`agent container exited with code ${code}`))
    );
  });

  try {
    return JSON.parse(readFileSync(metricsFile, "utf8")) as AgentMetrics;
  } catch (err) {
    throw new Error(
      `agent container finished but no metrics at ${metricsFile} — the in-container agent likely ` +
        `failed before writing them. (${String(err)})`
    );
  }
}

// Host-side launcher for the containerized post-agent lifecycle (container-only mode). One foreground
// `docker run` whose entrypoint (docker/lifecycle.sh) does the whole scored lifecycle — collector +
// weaver + app + traffic + flush + evaluate — in a single isolated PID+network namespace, then exits.
// This replaces the host's start/traffic/evaluate plumbing (harness.sh start_collector, free_port,
// lsof kill-before-start, ports.sh disjointness): with each run in its own netns, the in-container
// collector/weaver use fixed ports and nothing is published to the host, so parallel runs never collide.
//
// It is "harness mode" — trusted code, NO sandbox. Same mounts/HOME/per-app extras as the agent step
// (the app boots here too, so it needs its toolchain caches). Results come back via the bind-mounted
// tmp/.eval-results.<app>.json that src/run-eval.ts (invoked by lifecycle.sh) writes. A non-zero exit
// with no results means the app/collector failed to come up → surfaced as StartupFailure so run.ts
// records a failed run, mirroring the old host start path.
export async function runLifecycleInContainer(
  app: string,
  dataset: string,
  ingestKey: string,
  queryApiKey: string,
  runId: string,
  skill: SkillVersion
): Promise<FullEvaluation> {
  const resultsFile = resolve(harnessRoot, "tmp", `.eval-results.${app}.json`);
  rmSync(resultsFile, { force: true }); // never read a stale prior-run file

  const checkoutDir = resolve(harnessRoot, "checkouts", app);
  const tmpDir = resolve(harnessRoot, "tmp");
  const logsDir = resolve(harnessRoot, "logs", app);
  mkdirSync(logsDir, { recursive: true }); // mount source for the app/collector/weaver logs + report

  const { language } = readAppConfig(app);
  const image = imageFor(app);

  // Writable HOME outside /harness for the app's toolchain caches (uv, Go GOPATH/GOCACHE, Maven ~/.m2),
  // persisted host-side across runs — same strategy as the agent step.
  const containerHome = "/home/agent";
  const hostHomeDir = resolve(tmpDir, `.home-${app}`);
  mkdirSync(hostHomeDir, { recursive: true });
  if (app === "broadleaf") ensureSolrCache(); // seed/self-heal/capture (see ensureSolrCache)

  // The real Honeycomb destination the in-container collector forwards to (the app exports to the
  // collector, not directly to Honeycomb). Captured from the harness env; key forwarded by name below.
  const hcEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "https://api.honeycomb.io";

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const args = [
    "run",
    "--rm",
    // Named so `run.ts kill <app>` can `docker stop` a detached container.
    "--name",
    `harness-lifecycle-${app}`,
    // Write checkout/log/tmp edits as the host user so subsequent host-side git/scoring stay clean.
    "--user",
    `${uid}:${gid}`,
    // Give the run uid a real /etc/passwd entry (no-passwd --user breaks os/user.Current() → OTel init).
    ...passwdMountArgs(uid, gid, containerHome),
    // Mounts mirror the in-image /harness layout so paths resolve unchanged. All RW: the app writes a
    // DB/log into its checkout, the collector/weaver write logs + report into logs/<app>, and run-eval
    // writes the results into tmp/.
    "-v",
    `${checkoutDir}:${CONTAINER_ROOT}/checkouts/${app}`,
    "-v",
    `${tmpDir}:${CONTAINER_ROOT}/tmp`,
    "-v",
    `${logsDir}:${CONTAINER_ROOT}/logs/${app}`,
    "-v",
    `${hostHomeDir}:${containerHome}`,
    // Per-language / per-app extra mounts (java ~/.m2 cache, broadleaf seeded HSQLDB + Solr cache).
    ...extraDockerArgs(app, language, containerHome),
    "-e",
    `HOME=${containerHome}`,
    // Non-secret run config (safe on the argv).
    "-e",
    `HARNESS_RUN_ID=${runId}`,
    "-e",
    `HARNESS_DATASET=${dataset}`,
    "-e",
    `HARNESS_HC_ENDPOINT=${hcEndpoint}`,
    // Skill-version attributes — the in-container collector stamps these onto the Honeycomb-bound copy.
    "-e",
    `HARNESS_SKILL_BRANCH=${skill.branch}`,
    "-e",
    `HARNESS_SKILL_SHA=${skill.sha}`,
    "-e",
    `HARNESS_SKILL_COMMIT=${skill.commit}`,
    "-e",
    `HARNESS_SKILL_CONTENT_HASH=${skill.contentHash}`,
    "-e",
    `HARNESS_SKILL_UNCOMMITTED=${skill.uncommitted}`,
    // evaluate() reads HONEYCOMB_ENV at module load; forward it when set (defaults to "test").
    ...(process.env.HONEYCOMB_ENV ? ["-e", `HONEYCOMB_ENV=${process.env.HONEYCOMB_ENV}`] : []),
    // Secrets — forwarded by name only (values come from childEnv): collector→Honeycomb ingest key and
    // the eval's Honeycomb query key.
    "-e",
    "HARNESS_INGEST_KEY",
    "-e",
    "HONEYCOMB_QUERY_API_KEY",
    // Override the image ENTRYPOINT (run-agent.ts) with the harness-mode lifecycle orchestrator.
    "--entrypoint",
    "bash",
    image,
    "lifecycle.sh",
    app,
  ];

  const childEnv = {
    ...process.env,
    HARNESS_INGEST_KEY: ingestKey,
    HONEYCOMB_QUERY_API_KEY: queryApiKey,
  };

  const exitCode = await new Promise<number>((res, rej) => {
    const child = spawn("docker", args, { stdio: "inherit", env: childEnv });
    child.on("error", rej); // docker itself failed to launch (e.g. image missing)
    child.on("exit", (code) => res(code ?? 1));
  });

  if (!existsSync(resultsFile)) {
    // No results → the app/collector never got far enough to score. Treat as a startup failure so the
    // run is recorded as failed (not crashed), matching the old host start path.
    throw new StartupFailure(
      `lifecycle container exited with code ${exitCode} before producing eval results — ` +
        `check logs/${app}/ (collector.log, weaver.log, ${app} app log) and the console output above.`
    );
  }
  return JSON.parse(readFileSync(resultsFile, "utf8")) as FullEvaluation;
}
