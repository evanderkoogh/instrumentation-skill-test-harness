# BeaverHabits-Specific Evaluation Criteria

Run `./harness.sh beaverhabits traffic` first, then check these in Honeycomb against the
`beaverhabits` dataset (last 15 minutes). These supplement the common criteria in the
root `EVALUATION.md`.

## Expected HTTP routes (criterion 2)

Filter to `span.kind = server` + `http.route exists`. Breakdown by `http.route` should
include routes like `/demo`, `/demo/add`, `/demo/stats`, `/login`, `/register`. If
missing, the OTel Python SDK is not intercepting FastAPI request handlers.

## Expected database system (criterion 3)

`db.system` breakdown should show `sqlite`. If missing, SQLAlchemy async instrumentation
is not working.

## Expected trace structure (criterion 5)

A complete trace for a page request should show:
- HTTP handler (root, `span.kind = server`)
  - SQLAlchemy queries (`db.system = sqlite`)
  - (optional) custom business logic spans

## Additional quality criteria

### 7. Habit operations have user context
```
COUNT
BREAKDOWN: user.id (or enduser.id)
FILTER: http.route starts-with /demo
```
Expect: a consistent session/user identifier on habit page spans. Indicates the skill
added user context beyond auto-instrumentation defaults.

### 8. Async spans are connected
```
COUNT
FILTER: span.kind = server
BREAKDOWN: http.route
```
NiceGUI uses WebSocket connections for interactivity. Check that HTTP handler spans
for page loads are complete traces, not orphaned from their WebSocket context.

## Scoring additions

| Criteria | Weight | Notes |
| --- | --- | --- |
| 7 (user context) | High value | Business context beyond defaults |
| 8 (async connectivity) | High value | NiceGUI-specific propagation check |

The weaver registry the skill creates should declare the custom attributes above
(e.g. user/habit identifiers); `weaver_live_check` validates the emitted telemetry against
it. See the root `EVALUATION.md` for the weaver criterion.
