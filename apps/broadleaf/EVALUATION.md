# Broadleaf-Specific Evaluation Criteria

Run `./harness.sh broadleaf traffic` first, then check these in Honeycomb against the
`broadleaf-site` dataset (last 15 minutes). These supplement the common criteria
in the root `EVALUATION.md`.

## Expected HTTP routes (criterion 2)

Filter to `span.kind = server` + `http.route exists`. Breakdown by `http.route` should
include: `/hot-sauces`, `/hot-sauces/**`, `/cart/**`, `/search`, `/merchandise`. If
missing, the OTel Java agent is not attached or the wrong classpath is used.

## Expected database system (criterion 3)

`db.system` breakdown should show `hsqldb`. If missing, JDBC instrumentation is not
working — likely the agent is not loaded on the correct JVM.

## Expected trace structure (criterion 5)

A complete trace should show:
- HTTP handler (root)
  - Spring MVC dispatch
    - JDBC queries
    - (optional) custom business spans

## Additional quality criteria

### 7. Business context on cart operations
```
COUNT
BREAKDOWN: product.id
FILTER: http.route = /cart/add (or similar)
```
Expect: `product.id` populated. Indicates custom attributes beyond auto-instrumentation.

### 8. Checkout spans have order context
```
COUNT
BREAKDOWN: payment.type, order.item_count
FILTER: http.route contains checkout
```
Expect: `payment.type` and `order.item_count` present on checkout spans.

## Scoring additions

| Criteria | Weight | Notes |
| --- | --- | --- |
| 7 (cart product.id) | High value | Business context beyond defaults |
| 8 (checkout context) | High value | Distinguishes skill quality |
