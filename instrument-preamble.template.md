I'd like you to add OpenTelemetry instrumentation to my app (%APP_DESCRIPTION%) and send its
telemetry to Honeycomb. I'm after proper observability: traces, metrics, and logs, not just traces.

Here are the details. I've put them in a table with short field names so there's no ambiguity about
what each one is:

| field | value |
|---|---|
| `repo_path` | %REPO_DIR% |
| `service_name` | %APP_DATASET% |
| `language` | %APP_LANGUAGE% |
| `frameworks` | %APP_FRAMEWORKS% |
| `code_location` | %CODE_LOCATION% |
| `build_cmd` | %BUILD_HINT% |
| `start_cmd` | %START_HINT% |
| `ports` | %VERIFY_PORTS% |
| `readiness` | %READINESS% |
| `env_surface` | %ENV_SURFACE% |
| `stop_cmd` | %STOP_HINT% |
| `traffic_cmd` | `./%TRAFFIC_SCRIPT%` |
| `app_weaver_registry` | %WEAVER_REGISTRY% |
| `import_registries` | %IMPORT_REGISTRIES% |
| `attr_naming` | %ATTR_NAMING% |

Sending the telemetry:

- Export OTLP to %OTLP_ENDPOINT%, with the header `x-honeycomb-team=%API_KEY%` (that key is a secret —
  keep it out of git). The service name, custom-attribute naming, and weaver registries are in the
  table above.
- To exercise the app end-to-end there's a traffic script in the repo at `./%TRAFFIC_SCRIPT%` — run it
  (it honors `APP_HTTP_PORT` / `APP_HTTPS_PORT`; export them to the ports above), or hit the app's real
  routes directly.

A few ground rules:

- Please make all your changes inside `%REPO_DIR%` only.
- Treat this as a fresh start — don't rely on any earlier attempt to instrument this app; work only
  from what's in the repo now.
- You don't need Honeycomb to check your work, and you can't query it here anyway. Verify **locally**
  that telemetry is actually being produced — spans, metric datapoints, and log records — from the
  app's own console/file output. Something else runs the authoritative Honeycomb check afterwards, so
  don't wait on or depend on data showing up there.
- Everything you need is in this repo plus the OpenTelemetry tooling already installed on this machine.
  Don't run filesystem-wide searches (e.g. `find /`) — they're slow and unnecessary. If you can't
  locate something, ask me.
- Before you tell me it's done, confirm the telemetry is really being produced — don't just check that
  the app starts.
