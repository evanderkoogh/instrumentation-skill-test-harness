# RealWorld-Go-Specific Evaluation Criteria

Run `./harness.sh realworld-go traffic` first, then check these in Honeycomb against the
`realworld-go` dataset (last 15 minutes). These supplement the common criteria in the
root `EVALUATION.md`.

## Expected HTTP routes (criterion 2)

Filter to `span.kind = server` + `http.route exists`. The breakdown by `http.route` should
include parameterized templates, not raw URLs with IDs/slugs baked in. Expect routes like:
`/api/users`, `/api/users/login`, `/api/user`, `/api/articles`, `/api/articles/:slug`,
`/api/articles/:slug/comments`, `/api/articles/:slug/favorite`, `/api/profiles/:username`,
`/api/tags`.

- If routes are missing entirely, the Gin HTTP middleware (e.g. `otelgin`) is not wired in.
- If you see high-cardinality raw paths (e.g. `/api/articles/how-to-train-your-dragon-12345`)
  instead of `/api/articles/:slug`, the route template is not being captured — a quality miss.

## Expected database system (criterion 3)

`db.system` breakdown should show `sqlite`. If missing, GORM/database instrumentation is not
wired in (e.g. the `otelgorm` plugin or equivalent was not registered on the `*gorm.DB`).
Article and comment creation should produce INSERT spans; list/read endpoints SELECT spans.

## Expected trace structure (criterion 5)

A complete trace for `POST /api/articles` should show:
- HTTP handler (root, `span.kind = server`)
  - Gin handler / business logic
    - GORM database spans (INSERTs for the article + tags)

## Additional quality criteria

### 8. User context on authenticated spans
```
COUNT
BREAKDOWN: app.user.id   (or enduser.id / user.username — whatever the skill chose)
FILTER: http.route = /api/articles
        http.request.method = POST
```
Expect: the authenticated user identifier is present on spans for authenticated routes.
The JWT middleware resolves a user on every authenticated request, so the user id/username
is readily available to attach as a span attribute. Presence indicates custom enrichment
beyond raw auto-instrumentation.

### 9. Domain context on article operations
```
COUNT
BREAKDOWN: app.article.slug   (or article.slug — whatever the skill chose)
FILTER: http.route contains /articles/:slug
```
Expect: the article slug (and ideally tag list / favorite counts) captured as attributes on
article spans. Distinguishes thoughtful instrumentation from defaults.

## Scoring additions

| Criteria | Weight | Notes |
| --- | --- | --- |
| 2 (route templates, not raw slugs) | Required-ish | Raw slugs = high-cardinality anti-pattern |
| 8 (user context) | High value | Business context beyond defaults |
| 9 (article/domain context) | High value | Distinguishes skill quality |

The weaver registry the skill creates should declare the custom attributes above
(e.g. `app.user.id`, `app.article.slug`); `weaver_live_check` validates the emitted
telemetry against it. See the root `EVALUATION.md` for the weaver criterion.
