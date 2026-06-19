You are applying OpenTelemetry instrumentation to the RealWorld "Conduit" backend — a Go REST API (a Medium-style blogging service) built with the Gin web framework, GORM, and an embedded SQLite database. JWT is used for authentication.

Key facts about this codebase:
- Single Go module; entry point is `hello.go` (package main), which builds the Gin router and calls `r.Run`.
- Routes are grouped under the `/api` prefix (e.g. `/api/users`, `/api/articles`, `/api/profiles`, `/api/tags`). Route registration lives in the `users` and `articles` packages.
- Persistence is GORM over SQLite (`gorm.io/driver/sqlite`); the DB is opened in `common/database.go` and auto-migrated on startup.
- Honor standard OTel environment variables for exporter and resource configuration.
- Use `%APP_DATASET%` as the OpenTelemetry service name (`service.name` / `OTEL_SERVICE_NAME`) so traces land in the matching Honeycomb dataset and the harness can find them.

The harness compiles the binary with `go build` after instrumentation, so all instrumentation must be applied as Go source changes within the module (SDK setup, HTTP middleware, and any database/business spans). Do not rely on an external auto-instrumentation agent.
