You are applying OpenTelemetry instrumentation to the RealWorld "Conduit" backend — a Go REST API (a Medium-style blogging service) built with the Gin web framework, GORM, and an embedded SQLite database. JWT is used for authentication.

Key facts about this codebase:
- Single Go module; entry point is `hello.go` (package main), which builds the Gin router and calls `r.Run`.
- Routes are grouped under the `/api` prefix (e.g. `/api/users`, `/api/articles`, `/api/profiles`, `/api/tags`). Route registration lives in the `users` and `articles` packages.
- Persistence is GORM over SQLite (`gorm.io/driver/sqlite`); the DB is opened in `common/database.go` and auto-migrated on startup.
- Honor standard OTel environment variables for exporter and resource configuration.
- Use `%APP_DATASET%` as the OpenTelemetry service name (`service.name` / `OTEL_SERVICE_NAME`) so telemetry lands in the matching Honeycomb dataset and the harness can find it.

The harness compiles the binary with `go build` after instrumentation, so all instrumentation must be applied as Go source changes within the module. Because Go has no external auto-instrumentation agent, you must wire up **all three signals in code**: the trace, metric, and log SDK providers/exporters (e.g. the OTLP trace/metric/log exporters and a `slog` → OTel bridge), HTTP middleware, and any database/business spans, metrics, and log records. Do not rely on an external auto-instrumentation agent.
