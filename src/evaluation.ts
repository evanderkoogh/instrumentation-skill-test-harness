const HONEYCOMB_BASE = "https://api.honeycomb.io/1";
const HONEYCOMB_ENV = process.env.HONEYCOMB_ENV ?? "test";

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

async function runQueryOrNull(
  dataset: string,
  spec: QuerySpec,
  apiKey: string,
  timeRangeSecs = 900
): Promise<Record<string, unknown>[] | null> {
  try {
    return await runQuery(dataset, spec, apiKey, timeRangeSecs);
  } catch {
    return null;  // column doesn't exist or other query error → criterion fails
  }
}

async function runQuery(
  dataset: string,
  spec: QuerySpec,
  apiKey: string,
  timeRangeSecs = 900  // 15 minutes in seconds
): Promise<Record<string, unknown>[]> {
  const headers = {
    "X-Honeycomb-Team": apiKey,
    "X-Honeycomb-Environment": HONEYCOMB_ENV,
    "Content-Type": "application/json",
  };

  // Step 1: save query definition — spec goes directly (no wrapper), time_range is integer seconds
  const createRes = await fetch(`${HONEYCOMB_BASE}/queries/${dataset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...spec, time_range: timeRangeSecs }),
  });
  if (!createRes.ok) throw new Error(`Query create failed: ${createRes.status} ${await createRes.text()}`);
  const { id: queryId } = (await createRes.json()) as { id: string };

  // Step 2: start a query run
  const runRes = await fetch(`${HONEYCOMB_BASE}/query_results/${dataset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query_id: queryId, disable_series: false }),
  });
  if (!runRes.ok) throw new Error(`Query run failed: ${runRes.status} ${await runRes.text()}`);
  const { id: resultId } = (await runRes.json()) as { id: string };

  // Step 3: poll for completion
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${HONEYCOMB_BASE}/query_results/${dataset}/${resultId}`, { headers });
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
    const res = await fetch(`${HONEYCOMB_BASE}/columns/${dataset}`, {
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
  apiKey: string
): Promise<{ value: string; column: string } | null> {
  for (const column of ["db.system.name", "db.system"]) {
    const rows = await runQueryOrNull(
      dataset,
      {
        calculations: [{ op: "COUNT" }],
        filters: [{ column, op: "exists" }],
        breakdowns: [column],
      },
      apiKey
    );
    const value = rows?.[0]?.[column] as string | undefined;
    if (value) return { value, column };
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
  apiKey: string
): Promise<HoneycombCriteria> {
  const [spans, serviceNames, httpRoutes, dbResult, skillVersion, rootless, explosion, columns] =
    await Promise.all([
      runQuery(dataset, { calculations: [{ op: "COUNT" }] }, apiKey),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [{ column: "service.name", op: "exists" }],
          breakdowns: ["service.name"],
          orders: [{ op: "COUNT", order: "descending" }],
          limit: 10,
        },
        apiKey
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
        apiKey
      ),
      evaluateDbSystem(dataset, apiKey),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [
            { column: "service.instrumentation_skill.branch", op: "exists" },
          ],
          breakdowns: ["service.instrumentation_skill.branch"],
        },
        apiKey
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
        apiKey
      ),
      runQueryOrNull(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          breakdowns: ["name"],
          orders: [{ op: "COUNT", order: "descending" }],
          limit: 1,
        },
        apiKey
      ),
      fetchColumns(dataset, apiKey),
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
  // Deprecated semantic-convention attributes present in the dataset (null if columns unavailable).
  const deprecatedFound =
    columns === null ? null : columns.filter((c) => c in DEPRECATED_SEMCONV);

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
  };
}
