Follow the skill content below as your guide for instrumentation approach and methodology. You may consult public documentation and web resources as needed. Do not reuse any prior knowledge of how this specific project has been instrumented — treat this as a first-time engagement.

Working directory: %REPO_DIR%
CONSTRAINT: All changes must be made inside %REPO_DIR% only.

OTEL_EXPORTER_OTLP_ENDPOINT=%OTLP_ENDPOINT%
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=%API_KEY%

IMPORTANT — verify your instrumentation locally before finishing (do not just confirm the app starts):

- **Start the app yourself** to verify. It must bind these ports (the same ones the harness uses, so your run matches the evaluation): %VERIFY_PORTS%. Suggested start: %START_HINT%
- **Drive real traffic.** A copy of the representative-traffic script is in your checkout at `./%TRAFFIC_SCRIPT%` — run it (it honors `APP_HTTP_PORT`/`APP_HTTPS_PORT`; export them to the ports above), or hit the app's real routes directly. Importing or merely starting the app is NOT verification.
- **Capture spans with a console/file exporter** (e.g. `OTEL_TRACES_EXPORTER=console`) and inspect them directly. Do NOT rely on Honeycomb or depend on spans arriving there — the test harness runs the authoritative Honeycomb evaluation (its own traffic + queries) after you finish.
- **Clean up:** stop anything you started and remove or gate any temporary console/file exporter before finishing; do not commit changes that only export to the console.
