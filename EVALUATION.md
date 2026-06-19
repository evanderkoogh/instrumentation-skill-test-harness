# Instrumentation Evaluation Checklist

After applying instrumentation and generating traffic, verify the following in Honeycomb
against the app's dataset (last 15 minutes). App-specific additions are in
`apps/<app>/EVALUATION.md`.

## Minimum criteria (must pass)

### 1. Spans are arriving
```
COUNT
```
Expect: non-zero. If zero, check `OTEL_EXPORTER_OTLP_HEADERS` in `.env` and verify the
app is configured to export to Honeycomb.

### 1b. service.name is hardcoded correctly
```
COUNT
BREAKDOWN: service.name
FILTER: service.name exists
```
Expect: every span carries a stable, non-default `service.name`. The harness intentionally
does **not** set `OTEL_SERVICE_NAME`; the instrumentation skill is responsible for setting
it (derived from build config or the repo/directory name). The criterion is lenient about the
exact value — it only fails when `service.name` is absent or left at the OTel default
(`unknown_service`, optionally language-suffixed such as `unknown_service:go`), which means
it was never set.

### 2. HTTP handler spans exist
```
COUNT
BREAKDOWN: http.route
FILTER: span.kind = server
        http.route exists
```
Expect: meaningful route names are present on server spans. If missing, the OTel
SDK/agent is not intercepting HTTP handlers.

### 3. Database spans exist
```
COUNT
BREAKDOWN: db.system
FILTER: db.system exists
```
Expect: at least one `db.system` value present. If missing, database instrumentation is
not working.

### 4. Skill version is tagged
```
COUNT
BREAKDOWN: service.instrumentation_skill.branch, service.instrumentation_skill.git_sha
FILTER: service.instrumentation_skill.branch exists
```
Expect: the branch and SHA from `.skill-version`. If missing, `.skill-version` was not
loaded by the start script.

## Quality criteria (good instrumentation)

### 5. Trace completeness — root spans have children
```
COUNT
FILTER: parent_id does-not-exist
BREAKDOWN: http.route
```
Pick a root span trace ID and inspect it. A complete trace should show the HTTP handler
at the root with database and/or business logic spans as children.

### 6. No rootless multi-span traces
```
COUNT
FILTER: none.trace.parent_id does-not-exist
        any.trace.parent_id exists
```
Expect: 0. `none.trace.parent_id does-not-exist` finds traces with no root span.
`any.trace.parent_id exists` restricts to multi-span traces, exempting single-span
background operations that legitimately have no parent. A non-zero result means a
multi-span trace lost its root — typically an export timing issue, sampling mismatch,
or shutdown before flush.

### 7. No span explosion
```
COUNT
BREAKDOWN: name
ORDER: COUNT descending
```
If a single span name accounts for millions of spans in a short window, the skill likely
added spans in a loop or on a trivial helper. Flag this as an anti-pattern.

### 8. Semantic-convention registry — weaver live-check

Not a Honeycomb query. During the run the app's telemetry is fanned out (via a per-run
OTel Collector) to both Honeycomb **and** a `weaver registry live-check` OTLP receiver,
which scores the live telemetry against the weaver registry the skill created in the
checkout (skill step "Create weaver registry"). The harness auto-discovers the registry
(a directory containing `manifest.yaml`).

Expect: the skill created a custom registry (`registry_custom: true`), telemetry reached
weaver (`total_entities > 0`), and there are **0 violations** against that registry.
Improvements/information advisories are surfaced but do not fail the criterion. The full
advice report (violation/improvement counts by advice type) is recorded in `runs.jsonl`
under `weaver`.

This requires the bundled tooling (`./harness.sh <app> download-tools` fetches
`otel/weaver` + `otel/otelcol-contrib`); if unavailable the criterion is skipped and the
app exports straight to Honeycomb (the other criteria are unaffected).

## Scoring guide

| Criteria | Weight | Notes |
| --- | --- | --- |
| 1–4 + 1b (minimum) | Required | Fail = instrumentation broken, not just incomplete |
| 5 (trace completeness) | High value | Confirms context propagation works |
| 6 (no rootless traces) | Disqualifier | Indicates export or sampling misconfiguration |
| 7 (no explosion) | Disqualifier | One failure voids quality criteria |
| 8 (weaver live-check) | High value | Skill must create a registry; telemetry must match it |
| App-specific criteria | High value | See apps/<app>/EVALUATION.md |
