---
name: project-solr-known-good-cache
description: DONE (2026-06-26) — broadleaf Solr cache self-heals from a durable known-good copy in otel/
metadata:
  type: project
---

**Implemented 2026-06-26** in `src/container.ts` (`ensureSolrCache()` + `solrCacheComplete()`,
`DURABLE_SOLR_DIR`). Broadleaf's Solr cache is now robust to killed/parallel runs and reboots.

**The problem it fixed:** Broadleaf auto-downloads Solr (~225 MB `solr-8.11.3.tgz`) from the
rate-limited `archive.apache.org` into `${java.io.tmpdir}/solr-8.11.3` and skips the download only if a
complete extraction is present. The harness mounts the host cache (`os.tmpdir()/solr-8.11.3` →
container `/tmp/solr-8.11.3`). A run **killed mid-download** left a partial `.tgz` + incomplete
extraction, so the next boot re-downloaded from scratch (~25 min on the throttled mirror, looking like
a hung startup).

**How it works now:** a **durable known-good copy** lives at `otel/solr-8.11.3` (gitignored, alongside
the other downloaded tooling). `ensureSolrCache()` runs host-side before each broadleaf container
launch (both the agent step and the lifecycle step, the only places the app boots):
- durable good + run cache missing/corrupt → reseed the volatile run cache from durable (self-heal)
- durable absent + run cache good → capture it as the durable copy
- neither good → leave it; Broadleaf downloads on first boot (slow path, once per machine)

The ~225 MB copy only runs on the rare corrupt/first-good transition, never the steady state.

**Integrity marker** (`solrCacheComplete`): the cache is a nested layout — the tgz extracts to
`<cacheDir>/solr-8.11.3/`, so a complete extraction has BOTH `<cacheDir>/solr-8.11.3/bin/solr` and
`.../server/start.jar`. A partial download has neither → treated as absent and reseeded, never
half-trusted.

**Note:** `container.ts` is the **host-side launcher** (not in the baked-image file list), so this
change needed NO docker rebuild — contrast [[rebuild-images-after-harness-change]]. The initial
durable copy was captured 2026-06-26 from the then-good host cache.

See [[project_broadleaf_startup]] (stale-Solr recovery) and [[run-under-caffeinate]] (killed/slept
runs are what corrupt the cache in the first place).
