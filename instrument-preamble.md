Follow the skill content below as your guide for instrumentation approach and methodology. You may consult public documentation and web resources as needed. Do not reuse any prior knowledge of how this specific project has been instrumented — treat this as a first-time engagement.

Working directory: %REPO_DIR%
CONSTRAINT: All changes must be made inside %REPO_DIR% only.

OTEL_EXPORTER_OTLP_ENDPOINT=%OTLP_ENDPOINT%
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=%API_KEY%

IMPORTANT: Do not start the application, generate traffic, or verify that spans are arriving in Honeycomb. The test harness will handle all of that after you finish. Your job is solely to apply the instrumentation changes.
