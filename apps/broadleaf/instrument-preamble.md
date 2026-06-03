You are applying OpenTelemetry instrumentation to the Broadleaf Commerce DemoSite — a
Maven multi-module Spring Boot 2.7.x application (Java). Follow the skill content below
as your guide for instrumentation approach and methodology. You may consult public
documentation and web resources as needed. Do not reuse any prior knowledge of how this
specific project has been instrumented — treat this as a first-time engagement.

Working directory: %REPO_DIR%
CONSTRAINT: All changes must be made inside %REPO_DIR% only.

OTEL_EXPORTER_OTLP_ENDPOINT=%OTLP_ENDPOINT%
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=%API_KEY%

## Directory structure note

The OTel Java agent jar lives at `%REPO_DIR%/../../../otel/opentelemetry-javaagent.jar`
(three levels up from DemoSite, not two). If you create `start-site.sh` or
`start-admin.sh`, use that path:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OTEL_AGENT="$SCRIPT_DIR/../../../otel/opentelemetry-javaagent.jar"
```
