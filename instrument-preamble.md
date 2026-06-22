Follow the skill content below as your guide for instrumentation approach and methodology. You may consult public documentation and web resources as needed. Do not reuse any prior knowledge of how this specific project has been instrumented — treat this as a first-time engagement.

Working directory: %REPO_DIR%
CONSTRAINT: All changes must be made inside %REPO_DIR% only.

OTEL_EXPORTER_OTLP_ENDPOINT=%OTLP_ENDPOINT%
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=%API_KEY%

IMPORTANT: You SHOULD start the application and drive local traffic to verify your instrumentation — capture the emitted spans with a console/file exporter (e.g. `OTEL_TRACES_EXPORTER=console`) and inspect them directly. Do NOT rely on Honeycomb for verification and do NOT depend on spans arriving there: the test harness runs the authoritative Honeycomb evaluation (its own traffic + queries) after you finish, so leave that to it. Clean up anything you start (stop the app, remove or gate any temporary console/file exporter) before finishing, and do not commit changes that only export to the console.
