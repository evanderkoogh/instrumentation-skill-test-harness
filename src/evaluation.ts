const HONEYCOMB_BASE = "https://api.honeycomb.io/1";
const HONEYCOMB_ENV = process.env.HONEYCOMB_ENV ?? "test";

// Honeycomb routes OTLP metrics (regardless of service.name) into a single shared dataset
// named "metrics" in an Environments & Services environment, distinct from each service's
// trace/log dataset. The per-run collector stamps harness.run_id onto metric datapoints too
// (collector.template.yaml metrics pipeline), so we still scope by run inside this shared dataset.
const METRICS_DATASET = "metrics";

// Candidate metric instruments used to prove "metrics were received" without depending on a
// single SDK's metric set: HTTP-server latency covers the Python/Go SDKs, JVM/runtime metrics
// cover the Java agent and Go runtime instrumentation. Probed in order; the first whose
// datapoints carry THIS run's harness.run_id counts as received. Bare COUNT is rejected on
// metrics datasets ("aggregate operation not allowed"), so we MAX a metric and group by
// harness.run_id. Critically, MAX over a zero-match filter still returns a phantom {MAX: 0}
// row WITHOUT a harness.run_id value — so presence must be judged by the run_id appearing in a
// returned row, never by getting a number back. A probe whose column doesn't exist is rejected
// by the API and skipped. (current_semconv separately flags stale attribute names.)
const METRIC_PROBES = [
  "http.server.request.duration", // HTTP-server latency: Python/Go SDKs, most language agents
  "jvm.memory.used",              // JVM runtime: Java agent
  "process.runtime.go.goroutines", // Go runtime instrumentation
  "process.runtime.cpu.utilization", // generic process-runtime fallback
];

interface QuerySpec {
  calculations: Array<{ op: string; column?: string; name?: string }>;
  filters?: Array<{ column: string; op: string; value?: unknown }>;
  breakdowns?: string[];
  orders?: Array<{ op?: string; column?: string; order: string }>;
  limit?: number;
}

interface HoneycombResult {
  data: Record<string, unknown>;
}

// Honeycomb's query endpoints are rate-limited (≈10 requests / 60s). Under `run.ts --parallel`
// several apps evaluate at once, each firing many criteria queries, so bursts blow past the
// limit and the endpoint returns 429. Retry those with backoff (honoring Retry-After when
// present) so a transient rate-limit doesn't fail an otherwise-passing run. Non-429 responses
// are returned as-is for the caller to handle.
async function hcFetch(url: string, init: RequestInit, attempts = 6): Promise<Response> {
  let lastDelayMs = 2000;
  for (let i = 0; ; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || i >= attempts) return res;
    // Prefer the server's Retry-After (seconds); otherwise exponential backoff capped at 60s.
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(lastDelayMs, 60000);
    lastDelayMs = Math.min(lastDelayMs * 2, 60000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function runQueryOrNull(
  dataset: string,
  spec: QuerySpec,
  apiKey: string,
  runId?: string,
  timeRangeSecs = 900
): Promise<Record<string, unknown>[] | null> {
  try {
    return await runQuery(dataset, spec, apiKey, runId, timeRangeSecs);
  } catch {
    return null;  // column doesn't exist or other query error → criterion fails
  }
}

async function runQuery(
  dataset: string,
  spec: QuerySpec,
  apiKey: string,
  runId?: string,
  timeRangeSecs = 900  // 15 minutes in seconds
): Promise<Record<string, unknown>[]> {
  const headers = {
    "X-Honeycomb-Team": apiKey,
    "X-Honeycomb-Environment": HONEYCOMB_ENV,
    "Content-Type": "application/json",
  };

  // Scope to this run only — the dataset is shared across runs, so without this filter a
  // query would pick up spans (and persistent columns) from prior runs. harness.run_id is
  // stamped on every span by the per-run collector (collector.template.yaml).
  const scoped: QuerySpec = runId
    ? { ...spec, filters: [...(spec.filters ?? []), { column: "harness.run_id", op: "=", value: runId }] }
    : spec;

  // Step 1: save query definition — spec goes directly (no wrapper), time_range is integer seconds
  const createRes = await hcFetch(`${HONEYCOMB_BASE}/queries/${dataset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...scoped, time_range: timeRangeSecs }),
  });
  if (!createRes.ok) throw new Error(`Query create failed: ${createRes.status} ${await createRes.text()}`);
  const { id: queryId } = (await createRes.json()) as { id: string };

  // Step 2: start a query run
  const runRes = await hcFetch(`${HONEYCOMB_BASE}/query_results/${dataset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query_id: queryId, disable_series: false }),
  });
  if (!runRes.ok) throw new Error(`Query run failed: ${runRes.status} ${await runRes.text()}`);
  const { id: resultId } = (await runRes.json()) as { id: string };

  // Step 3: poll for completion
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await hcFetch(`${HONEYCOMB_BASE}/query_results/${dataset}/${resultId}`, { headers });
    if (!res.ok) throw new Error(`Query poll failed: ${res.status}`);
    const data = (await res.json()) as {
      complete: boolean;
      data?: { results: HoneycombResult[] };
    };
    if (data.complete) return (data.data?.results ?? []).map((r) => r.data);
  }
  throw new Error("Honeycomb query timed out");
}

// Fetch all column key-names for a dataset. Returns null if the listing fails.
async function fetchColumns(dataset: string, apiKey: string): Promise<string[] | null> {
  try {
    const res = await hcFetch(`${HONEYCOMB_BASE}/columns/${dataset}`, {
      headers: {
        "X-Honeycomb-Team": apiKey,
        "X-Honeycomb-Environment": HONEYCOMB_ENV,
      },
    });
    if (!res.ok) return null;
    const cols = (await res.json()) as Array<{ key_name: string }>;
    return cols.map((c) => c.key_name);
  } catch {
    return null;
  }
}

// Deprecated OTel semantic-convention attribute names → their current replacement.
// Modern SDKs/instrumentation emit the right-hand names; presence of a left-hand name
// means the instrumentation is emitting stale conventions.
const DEPRECATED_SEMCONV: Record<string, string> = {
  // HTTP
  "http.method": "http.request.method",
  "http.status_code": "http.response.status_code",
  "http.url": "url.full",
  "http.target": "url.path",
  "http.scheme": "url.scheme",
  "http.host": "server.address",
  "http.user_agent": "user_agent.original",
  "http.request_content_length": "http.request.body.size",
  "http.response_content_length": "http.response.body.size",
  "http.flavor": "network.protocol.version",
  // Network
  "net.peer.name": "server.address",
  "net.peer.port": "server.port",
  "net.peer.ip": "network.peer.address",
  "net.host.name": "server.address",
  "net.host.port": "server.port",
  "net.sock.peer.addr": "network.peer.address",
  "net.sock.peer.port": "network.peer.port",
  "net.transport": "network.transport",
  "net.protocol.name": "network.protocol.name",
  "net.protocol.version": "network.protocol.version",
  // Database
  "db.system": "db.system.name",
  "db.statement": "db.query.text",
  "db.operation": "db.operation.name",
  "db.name": "db.namespace",
  "db.sql.table": "db.collection.name",
  // Messaging / FaaS / user
  "messaging.destination": "messaging.destination.name",
  "messaging.destination_kind": "messaging.operation.type",
  "faas.execution": "faas.invocation_id",
  "enduser.id": "user.id",
};

// Determine the database system value, preferring the current semconv attribute
// (db.system.name) and falling back to the deprecated one (db.system).
async function evaluateDbSystem(
  dataset: string,
  apiKey: string,
  runId?: string
): Promise<{ value: string; column: string } | null> {
  for (const column of ["db.system.name", "db.system"]) {
    const rows = await runQueryOrNull(
      dataset,
      {
        calculations: [{ op: "COUNT" }],
        filters: [{ column, op: "exists" }],
        breakdowns: [column],
      },
      apiKey,
      runId
    );
    const value = rows?.[0]?.[column] as string | undefined;
    if (value) return { value, column };
  }
  return null;
}

// Prove metric datapoints were received for THIS run by querying the shared metrics dataset.
// runQueryOrNull scopes by harness.run_id; we also break down by it so we can confirm the run's
// id actually appears in a returned row — MAX alone returns a phantom {MAX: 0} (no run_id) on a
// zero match, so a bare number is NOT proof. Returns the matching probe (+ its value) or null if
// no probe's datapoints carry this run_id. A non-existent metric column makes the query error,
// which runQueryOrNull turns into null, so missing probes are skipped without throwing.
async function evaluateMetricsReceived(
  apiKey: string,
  runId?: string
): Promise<{ value: number; metric: string } | null> {
  if (!runId) return null; // presence is run-scoped; without a run id there's nothing to match
  for (const column of METRIC_PROBES) {
    const rows = await runQueryOrNull(
      METRICS_DATASET,
      { calculations: [{ op: "MAX", column }], breakdowns: ["harness.run_id"] },
      apiKey,
      runId
    );
    const hit = rows?.find((r) => r["harness.run_id"] === runId);
    if (hit) return { value: hit[`MAX(${column})`] as number, metric: column };
  }
  return null;
}

export interface CriterionResult {
  pass: boolean;
  value?: unknown;
}

// Criteria derived from querying Honeycomb (what evaluate() computes).
export interface HoneycombCriteria {
  spans_arriving: CriterionResult;
  service_name: CriterionResult;
  http_routes: CriterionResult;
  db_spans: CriterionResult;
  skill_version: CriterionResult;
  rootless_traces: CriterionResult;
  no_explosion: CriterionResult;
  current_semconv: CriterionResult;
  metrics_received: CriterionResult;
  logs_received: CriterionResult;
}

// Full criteria set recorded for a run: the Honeycomb criteria plus the local
// criteria computed separately in run.ts — the weaver live-check verdict
// (src/weaver.ts) and the agent's env-var communication (src/envvars.ts).
export interface EvaluationResults extends HoneycombCriteria {
  weaver_live_check: CriterionResult;
  env_var_output: CriterionResult;
}

export async function evaluate(
  dataset: string,
  apiKey: string,
  runId?: string
): Promise<HoneycombCriteria> {
  const [
    spans,
    serviceNames,
    httpRoutes,
    dbResult,
    skillVersion,
    rootless,
    explosion,
    columns,
    metricsResult,
    logsRows,
  ] =
    await Promise.all([
      runQuery(dataset, { calculations: [{ op: "COUNT" }] }, apiKey, runId),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [{ column: "service.name", op: "exists" }],
          breakdowns: ["service.name"],
          orders: [{ op: "COUNT", order: "descending" }],
          limit: 10,
        },
        apiKey,
        runId
      ),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [
            { column: "span.kind", op: "=", value: "server" },
            { column: "http.route", op: "exists" },
          ],
          breakdowns: ["http.route"],
          orders: [{ op: "COUNT", order: "descending" }],
          limit: 10,
        },
        apiKey,
        runId
      ),
      evaluateDbSystem(dataset, apiKey, runId),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [
            { column: "service.instrumentation_skill.branch", op: "exists" },
          ],
          breakdowns: ["service.instrumentation_skill.branch"],
        },
        apiKey,
        runId
      ),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [
            { column: "none.trace.parent_id", op: "does-not-exist" },
            { column: "any.trace.parent_id", op: "exists" },
          ],
        },
        apiKey,
        runId
      ),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          breakdowns: ["name"],
          orders: [{ op: "COUNT", order: "descending" }],
          limit: 1,
        },
        apiKey,
        runId
      ),
      fetchColumns(dataset, apiKey),
      // Metrics land in the shared "metrics" dataset; probe HTTP server-duration, run-scoped.
      evaluateMetricsReceived(apiKey, runId),
      // Logs land in the service's own dataset alongside spans, tagged meta.signal_type=log.
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [{ column: "meta.signal_type", op: "=", value: "log" }],
        },
        apiKey,
        runId
      ),
    ]);

  const totalSpans = (spans[0]?.["COUNT"] as number) ?? 0;
  // service.name is set by the instrumentation (the harness no longer sets
  // OTEL_SERVICE_NAME). The skill derives the name from build config or the repo/dir
  // name, so we don't require an exact value — only that every span carries a stable,
  // non-default name. The OTel default ("unknown_service", optionally suffixed with the
  // language, e.g. "unknown_service:go") means service.name was never set.
  const serviceNameValues = (serviceNames ?? []).map((r) => r["service.name"] as string);
  const isDefaultServiceName = (v: string) => !v || v.startsWith("unknown_service");
  const serviceNameOk =
    serviceNames !== null &&
    serviceNameValues.length > 0 &&
    serviceNameValues.every((v) => !isDefaultServiceName(v));
  const httpRouteRows = (httpRoutes ?? []).filter(
    (r) => r["http.route"] !== "/*" && r["http.route"] !== "/"
  );
  const rootlessCount = (rootless?.[0]?.["COUNT"] as number) ?? 0;
  const topSpanCount = (explosion?.[0]?.["COUNT"] as number) ?? 0;
  const logCount = (logsRows?.[0]?.["COUNT"] as number) ?? 0;
  // current_semconv must be RUN-SCOPED. `columns` is the dataset's column schema, which
  // persists across runs — a legacy column existing there only means *some* past run emitted
  // it, not this one. So take the legacy columns as candidates, then confirm each is actually
  // present in THIS run's spans (run-scoped existence query) before flagging it.
  const legacyCandidates = columns === null ? null : columns.filter((c) => c in DEPRECATED_SEMCONV);
  const deprecatedFound =
    legacyCandidates === null
      ? null
      : (
          await Promise.all(
            legacyCandidates.map(async (c) => {
              const rows = await runQueryOrNull(
                dataset,
                { calculations: [{ op: "COUNT" }], filters: [{ column: c, op: "exists" }] },
                apiKey,
                runId
              );
              return ((rows?.[0]?.["COUNT"] as number) ?? 0) > 0 ? c : null;
            })
          )
        ).filter((c): c is string => c !== null);

  return {
    spans_arriving: { pass: totalSpans > 0, value: totalSpans },
    service_name: {
      pass: serviceNameOk,
      value:
        serviceNames === null
          ? "column absent"
          : serviceNameValues.length === 0
            ? "no service.name"
            : serviceNameValues,
    },
    http_routes: {
      pass: httpRoutes !== null && httpRouteRows.length > 0,
      value: httpRoutes === null ? "column absent" : httpRouteRows.map((r) => r["http.route"]),
    },
    db_spans: {
      pass: dbResult !== null,
      value: dbResult
        ? `${dbResult.value} (${dbResult.column})`
        : "column absent",
    },
    skill_version: {
      pass: skillVersion !== null && ((skillVersion[0]?.["COUNT"] as number) ?? 0) > 0,
      value: skillVersion?.[0]?.["service.instrumentation_skill.branch"] ?? "column absent",
    },
    rootless_traces: { pass: rootless !== null && rootlessCount === 0, value: rootlessCount },
    no_explosion: { pass: explosion !== null && topSpanCount < 10_000, value: topSpanCount },
    current_semconv: {
      pass: deprecatedFound !== null && deprecatedFound.length === 0,
      value:
        deprecatedFound === null
          ? "columns unavailable"
          : deprecatedFound.length === 0
            ? "none"
            : deprecatedFound.map((c) => `${c} → ${DEPRECATED_SEMCONV[c]}`),
    },
    metrics_received: {
      pass: metricsResult !== null,
      value: metricsResult
        ? `${metricsResult.metric} (max ${metricsResult.value})`
        : "no metric datapoints",
    },
    logs_received: {
      pass: logsRows !== null && logCount > 0,
      value: logsRows === null ? "column absent" : logCount,
    },
  };
}
