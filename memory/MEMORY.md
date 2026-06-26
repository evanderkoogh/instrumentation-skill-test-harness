# Memory Index

- [User profile](user_erwin.md) — Erwin's role, preferences, collaboration style
- [Portable skills are the deliverable](project-goal-portable-skills.md) — fix instrumentation quality in the skill, not the harness; harness changes only for better measurement
- [Always run under caffeinate](run-under-caffeinate.md) — wrap harness runs in `caffeinate -dimsu`; laptop sleep mid-run corrupts results
- [Rebuild images after harness change](rebuild-images-after-harness-change.md) — edits to baked harness files (src/*.ts, harness.sh, lifecycle.sh, templates) need a docker rebuild (base then lang) to take effect
- [Git workflow per repo](trunk-based-dev.md) — harness: trunk-based (push to main); agent-skill: commit on the long-running refactor feature branch
- [Orchestrator as planner](orchestrator-as-planner.md) — want the otel-instrumentation conductor to plan + ask the user interactive questions when info for the sub-agents is missing
- [Observing a run](observing-a-run.md) — full picture of a run: local logs + runs.jsonl + the three Honeycomb streams, all scoped by runId
- [Agent telemetry as GenAI conventions](genai-conventions-agent-telemetry.md) — how the per-run agent collector remaps the SDK's claude_code.* into gen_ai.* + the opt-in content-capture vars
- [Full run report spec](full-run-report-spec.md) — sections + data sources for the full HTML run report: metrics, failure investigations, agent interactions, per-agent actions, expandable call table
- [Adding a new app](project_add_new_app.md) — config.sh, baseline files, traffic.sh, preamble; Java/Python/Node callouts; check implementer skill has a references/<lang>.md guide
- [Broadleaf startup mechanics](project_broadleaf_startup.md) — exploded JAR, LTW, bootstrap, HSQLDB facts, stale Solr recovery
- [Solr known-good cache](project-solr-known-good-cache.md) — DONE 2026-06-26: broadleaf Solr cache self-heals from a durable copy in otel/ (ensureSolrCache in container.ts); avoids ~25min re-download on a corrupted cache
- [Verifier collector thrash](project-verifier-collector-thrash.md) — otel-verification skill makes the verifier hand-roll its own otelcol+weaver, which thrashes on ports / hangs; skill issue, not a harness bug
- [Containerize eval plan](project_containerize_eval_plan.md) — pending plan: run build+start+traffic+evaluate in one image via sandbox-protected answer key; see ~/.claude/plans/create-a-plan-for-pure-moon.md
- [No preamble edits](feedback-no-preamble-edits.md) — preambles hold only general framing + app-start facts, never instrumentation how-to (that goes in the skill); suggest-and-ask, never bake in
