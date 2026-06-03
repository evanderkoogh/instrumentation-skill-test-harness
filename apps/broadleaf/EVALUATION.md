# Instrumentation Evaluation Checklist

After applying instrumentation and running `./broadleaf.sh traffic`, verify the following
in Honeycomb against the `broadleaf-site` dataset (last 15 minutes).

## Minimum criteria (must pass)

### 1. Spans are arriving
```
COUNT
```
Expect: non-zero. If zero, check `OTEL_EXPORTER_OTLP_HEADERS` in `.env` and that
`service.instrumentation_skill.branch` is set on spans (confirms `.skill-version` loaded).

### 2. HTTP handler spans exist
```
COUNT
BREAKDOWN: http.route
FILTER: http.route exists
```
Expect: routes like `/hot-sauces`, `/hot-sauces/**`, `/cart/**`, etc. are present.
If missing: the OTel Java agent is not attached or the wrong classpath is used.

### 3. Database spans exist
```
COUNT
BREAKDOWN: db.system
FILTER: db.system exists
```
Expect: `hsqldb` rows. If missing: JDBC instrumentation is not working — likely the
agent is not loaded on the correct JVM.

### 4. Skill version is tagged
```
COUNT
BREAKDOWN: service.instrumentation_skill.branch, service.instrumentation_skill.git_sha
FILTER: service.instrumentation_skill.branch exists
```
Expect: the branch and SHA from `DemoSite/.skill-version`. If missing: `.skill-version`
was not found by the start script.

## Quality criteria (good instrumentation)

### 5. Business context attributes on cart operations
```
COUNT
BREAKDOWN: product.id
FILTER: http.route = /cart/add (or similar)
```
Expect: `product.id` populated. Indicates the skill added custom attributes beyond
auto-instrumentation defaults.

### 6. Checkout spans have order context
```
COUNT
BREAKDOWN: payment.type, order.item_count
FILTER: http.route contains checkout
```
Expect: `payment.type` and `order.item_count` on checkout spans.

### 7. Trace completeness — root spans have children
```
COUNT
FILTER: parent_id does-not-exist
BREAKDOWN: http.route
```
Pick a root span trace ID and inspect it. A complete trace should show:
- HTTP handler (root)
  - Spring MVC dispatch
    - JDBC queries
    - (optional) custom business spans

### 8. No span explosion
```
COUNT
BREAKDOWN: name
ORDER: COUNT descending
```
If a single span name accounts for millions of spans in a short window, the skill likely
added spans in a loop or on a trivial helper. Flag this as an anti-pattern.

## Scoring guide

| Criteria | Weight | Notes |
| --- | --- | --- |
| 1–4 (minimum) | Required | Fail = instrumentation broken, not just incomplete |
| 5–6 (business attributes) | High value | Distinguishes skill quality |
| 7 (trace completeness) | High value | Confirms context propagation works |
| 8 (no explosion) | Disqualifier | One failure voids quality criteria |
