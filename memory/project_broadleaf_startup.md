---
name: project-broadleaf-startup
description: Broadleaf DemoSite startup mechanics — exploded JAR, LTW, HSQLDB, bootstrap
metadata:
  type: project
---

Broadleaf Commerce DemoSite (Spring Boot 2.7.x, Java 25) has several non-obvious startup requirements.

**Run method:** Use exploded JAR + `java -cp`, NOT `java -jar` and NOT `mvn spring-boot:run`. The fat JAR's nested classloader breaks Broadleaf's JPA entity extension scanning (missing `BLC_INDEX_FIELD_TYPE.ARCHIVED` column → Solr indexer crash → ApplicationContext failure).

**Why:** Broadleaf uses Spring Load-Time Weaving (`spring-instrument.jar`) to weave entity fields at class-load time. A standard JVM classpath via `java -cp` is required for this to work correctly.

**How to apply:** Always update `start-site.sh` and `start-admin.sh` in DemoSite/. The harness (`./harness.sh broadleaf start`) calls these scripts.

**HSQLDB bootstrap:** The embedded HSQLDB stores files at `/tmp/broadleaf-hsqldb`. These persist across normal restarts but are wiped on system reboot. `npx tsx run.ts broadleaf` runs bootstrap automatically; it's a no-op if already seeded. If `start` fails with a schema error, run `./harness.sh broadleaf bootstrap` manually.

**Stale Solr:** Solr runs as a child process on port 8983 and stores its index under `/var/folders/.../T/solr-8.11.3/`. If a previous run crashed without a clean shutdown, the next bootstrap will fail with `SolrCore 'catalog_reindex' is not available due to init failure`. Fix: `kill $(lsof -ti :8983)` then `rm -rf /var/folders/sc/*/T/solr-8.11.3/`.

**Start sequence:** Site must fully start (Solr up) before admin. The harness waits for `Started SiteApplication` (not just `Started `) to avoid racing on the "Started Solr server" line. Admin is then started and waits for `Started AdminApplication`.

**Ports:** site HTTP 8080 / HTTPS 8443; admin HTTP 8081 / HTTPS 8444; Solr 8983. HSQLDB is **embedded/file-based** (`/tmp/broadleaf-hsqldb`) and opens NO network port (9001 is HSQLDB's server-mode default, unused here). The four Spring ports are configurable via `APP_HTTP_PORT` / `APP_HTTPS_PORT` / `APP_ADMIN_HTTP_PORT` / `APP_ADMIN_HTTPS_PORT` in `config.sh`, passed to the JVM as `-Dhttp.server.port` / `-Dserver.port` by the start scripts. `-Dserver.port` (HTTPS, the traffic target) reliably overrides; `-Dhttp.server.port` is a Broadleaf-custom property and may not.
