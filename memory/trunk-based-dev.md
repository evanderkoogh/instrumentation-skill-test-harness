---
name: trunk-based-dev
description: Git workflow per repo — harness is trunk-based (push to main); agent-skill uses a long-running feature branch
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 417a2b80-b798-4244-acd3-9b6ceb9a1a24
---

Git workflow differs by repo:

- **instrumentation-skill-test-harness** (this repo): trunk-based development. Commit and push directly to `main` — do **not** create a feature branch first.
- **agent-skill** (the sibling portable-skills repo): **not** trunk-based. Work happens on a long-running feature branch — currently `evanderkoogh/major-instrumentation-refactor` (the instrumentation refactor). Commit there, not to `main`.

**Why:** Overrides the default "if on the default branch, branch first" behavior for the harness; the skill repo deliberately stages a big refactor on its own branch. User confirmed/corrected this on 2026-06-23.

**How to apply:** Harness → commit/push on `main` without branching. agent-skill → commit on its current feature branch (run `git branch` to confirm; don't switch to or push `main`). Still only commit/push when explicitly asked. See also [[run-under-caffeinate]] and [[project-goal-portable-skills]].
