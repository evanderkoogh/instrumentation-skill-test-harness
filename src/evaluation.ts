const HONEYCOMB_BASE = "https://api.honeycomb.io/1";
const HONEYCOMB_ENV = "test";

interface QuerySpec {
  calculations: Array<{ op: string; column?: string; name?: string }>;
  filters?: Array<{ column: string; op: string; value?: unknown }>;
  breakdowns?: string[];
  orders?: Array<{ op?: string; column?: string; order: string }>;
  limit?: number;
  time_range?: string;
}

interface HoneycombResult {
  [key: string]: unknown;
}

async function runQuery(
  dataset: string,
  spec: QuerySpec,
  apiKey: string,
  timeRange = "15m"
): Promise<HoneycombResult[]> {
  const headers = {
    "X-Honeycomb-Team": apiKey,
    "X-Honeycomb-Environment": HONEYCOMB_ENV,
    "Content-Type": "application/json",
  };

  const createRes = await fetch(`${HONEYCOMB_BASE}/queries/${dataset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: { ...spec, time_range: timeRange }, limit: 100 }),
  });
  if (!createRes.ok) throw new Error(`Query create failed: ${createRes.status}`);
  const { id: queryId } = (await createRes.json()) as { id: string };

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${HONEYCOMB_BASE}/query_results/${queryId}`, { headers });
    if (!res.ok) throw new Error(`Query results failed: ${res.status}`);
    const data = (await res.json()) as {
      complete: boolean;
      data?: { results: HoneycombResult[] };
    };
    if (data.complete) return data.data?.results ?? [];
  }
  throw new Error("Honeycomb query timed out");
}

export interface CriterionResult {
  pass: boolean;
  value?: unknown;
}

export interface EvaluationResults {
  spans_arriving: CriterionResult;
  http_routes: CriterionResult;
  db_spans: CriterionResult;
  skill_version: CriterionResult;
  rootless_traces: CriterionResult;
  no_explosion: CriterionResult;
}

export async function evaluate(
  dataset: string,
  apiKey: string
): Promise<EvaluationResults> {
  const [spans, httpRoutes, dbSpans, skillVersion, rootless, explosion] =
    await Promise.all([
      runQuery(dataset, { calculations: [{ op: "COUNT" }] }, apiKey),
      runQuery(
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
      runQuery(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          filters: [{ column: "db.system", op: "exists" }],
          breakdowns: ["db.system"],
        },
        apiKey
      ),
      runQuery(
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
      runQuery(
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
      runQuery(
        dataset,
        {
          calculations: [{ op: "COUNT" }],
          breakdowns: ["name"],
          orders: [{ op: "COUNT", order: "descending" }],
          limit: 1,
        },
        apiKey
      ),
    ]);

  const totalSpans = (spans[0]?.["COUNT"] as number) ?? 0;
  const httpRouteRows = httpRoutes.filter(
    (r) => r["http.route"] !== "/*" && r["http.route"] !== "/"
  );
  const dbSystem = dbSpans[0]?.["db.system"] as string | undefined;
  const rootlessCount = (rootless[0]?.["COUNT"] as number) ?? 0;
  const topSpanCount = (explosion[0]?.["COUNT"] as number) ?? 0;

  return {
    spans_arriving: { pass: totalSpans > 0, value: totalSpans },
    http_routes: {
      pass: httpRouteRows.length > 0,
      value: httpRouteRows.map((r) => r["http.route"]),
    },
    db_spans: { pass: !!dbSystem, value: dbSystem },
    skill_version: {
      pass: (skillVersion[0]?.["COUNT"] as number ?? 0) > 0,
      value: skillVersion[0]?.["service.instrumentation_skill.branch"],
    },
    rootless_traces: { pass: rootlessCount === 0, value: rootlessCount },
    no_explosion: { pass: topSpanCount < 10_000, value: topSpanCount },
  };
}
