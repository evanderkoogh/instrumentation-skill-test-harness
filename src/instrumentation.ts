import { query, type HookInput, type HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { makeFsGuard, denyReason } from "./sandbox.js";
import { costFromModelUsage, type CostBreakdown, type TokenBreakdown } from "./pricing.js";
const __dirname = dirname(fileURLToPath(import.meta.url));

function toolDetail(name: string, input: Record<string, unknown>): string {
  const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ");
  const trunc = (s: unknown, n = 80) => clean(s).slice(0, n);
  switch (name) {
    // File paths are shown in full so the checkout-only constraint is auditable from logs.
    case "Read":    return ` ${clean(input.file_path)}`;
    case "Write":   return ` ${clean(input.file_path)}`;
    case "Edit":    return ` ${clean(input.file_path)}`;
    // Bash commands can be arbitrarily long; keep these capped.
    case "Bash":    return `  ${trunc(input.command, 120)}`;
    // Sub-agent spawn (verification hand-off) — surface which agent + the task.
    case "Agent":
    case "Task":    return ` [${clean(input.subagent_type ?? "?")}] ${trunc(input.description ?? input.prompt, 80)}`;
    default:        return "";
  }
}

export interface AgentMetrics {
  duration_ms: number;
  tool_uses: number;
  input_tokens: number; // uncached input only
  output_tokens: number;
  // Cache tokens dominate cost on a long agentic run but were previously
  // ignored, making total_tokens (and any cost derived from it) meaningless.
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  // total_tokens is the full billed prompt + output = input + output + cache
  // read + cache creation. (Historically this was only input + output.)
  total_tokens: number;
  cost: CostBreakdown; // single dollar figure (+ per-bucket breakdown)
  // The agent SDK's own cost figure, when it reports one — a cross-check
  // against our token-derived `cost.total_usd`.
  sdk_cost_usd: number | null;
  model: string;
  session_id: string;
}

export interface SkillVersion {
  branch: string;
  sha: string;
  commit: string;
  // Authoritative "what actually ran" id — a hash of the live skill files (reflects
  // uncommitted edits the git sha misses). `uncommitted` flags that the sha is incomplete.
  contentHash: string;
  uncommitted: boolean;
  // Human label of intent for this run, passed in via `--skill-desc` (optional).
  description?: string;
}

export async function runInstrumentation(
  app: string,
  apiKey: string,
  model?: string,
  skill?: SkillVersion
): Promise<AgentMetrics> {
  const promptPath = resolve(__dirname, "..", "tmp", `.instrument-prompt.${app}.md`);
  const prompt = readFileSync(promptPath, "utf8");
  const harnessRoot = resolve(__dirname, "..");
  const repoDir = resolve(harnessRoot, "checkouts", app);

  // Hard sandbox: confine the agent's filesystem access to its own checkout (+ the bundled
  // weaver in otel/) so it can't read the harness's eval code / EVALUATION.md and overfit
  // the scoring. Enforced as a PreToolUse hook, which denies authoritatively regardless of
  // allowedTools. System paths, dependency caches, and /tmp stay reachable for builds.
  const guard = makeFsGuard({ repoDir, harnessRoot });
  let sandboxDenials = 0;
  const fsGuardHook = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const verdict = guard.inspect(input.tool_name, input.tool_input);
    if (verdict.allow) return {};
    sandboxDenials++;
    console.log(`  [${app}|sandbox] DENY ${input.tool_name} → ${verdict.target}`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyReason(verdict.target ?? "that path"),
      },
    };
  };

  const start = Date.now();
  let toolUses = 0;
  // Cumulative usage comes from the result event's `modelUsage` map (per model,
  // whole-session totals). The top-level `usage` field is only the final turn —
  // reading it under-counts tokens (and cost) by ~10x on a long run.
  let perModel: Array<{ model: string; tokens: TokenBreakdown }> = [];
  let sdkCostUsd: number | null = null;
  let resolvedModel = model ?? "unknown";
  let sessionId = "unknown";
  // The agent's final summary text — where it communicates the required env-var contract
  // to the user. Persisted for the env_var_output evaluation criterion.
  let finalOutput = "";

  try {
    for await (const event of query({
      prompt,
      options: {
        // Provide the same capabilities a real Claude Code install has, then let the SKILLS
        // and shipped AGENTS drive the work. "Agent"/"Task" so the agent can spawn sub-agents;
        // `skills: all` to enable discovery; `plugins` loads the honeycomb plugin from the LIVE
        // repo (not the stale version-pinned cache) so the current skills + agents — including
        // otel-verification and the orchestrator agents — are discoverable. The harness defines
        // nothing itself; everything it exercises is shipped in the plugin.
        allowedTools: ["Read", "Write", "Edit", "Bash", "Agent", "Task"],
        skills: "all",
        plugins: [{ type: "local", path: resolve(harnessRoot, "agent-skill", "honeycomb") }],
        cwd: repoDir,
        maxTurns: 150,
        hooks: {
          PreToolUse: [{ hooks: [fsGuardHook] }],
        },
        ...(model ? { model } : {}),
        env: {
          ...process.env,           // inherit auth tokens and PATH
          // Make the bundled `weaver` binary callable by the agent (skill step
          // "Create weaver registry" has it run `weaver registry check` to self-validate).
          PATH: `${resolve(__dirname, "..", "otel")}:${process.env.PATH ?? ""}`,
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
          OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${apiKey}`,
          OTEL_LOG_TOOL_DETAILS: "1",
          // Shorten export intervals so spans flush before the process exits
          OTEL_TRACES_EXPORT_INTERVAL: "1000",
          OTEL_LOGS_EXPORT_INTERVAL: "1000",
          OTEL_METRIC_EXPORT_INTERVAL: "5000",
          OTEL_SERVICE_NAME: `${app}-instrumentation`,
          OTEL_RESOURCE_ATTRIBUTES: [
            `app=${app}`,
            skill ? `skill.branch=${encodeURIComponent(skill.branch)}` : "",
            skill ? `skill.sha=${encodeURIComponent(skill.sha)}` : "",
            skill ? `skill.content_hash=${encodeURIComponent(skill.contentHash)}` : "",
            skill ? `skill.uncommitted=${skill.uncommitted}` : "",
            skill?.description ? `skill.description=${encodeURIComponent(skill.description)}` : "",
          ].filter(Boolean).join(","),
        },
      },
    })) {
      if (event.type === "system" && event.subtype === "init") {
        resolvedModel = event.model;
        sessionId = event.session_id;
      } else if (event.type === "assistant") {
        // Which agent produced this message: the main thread ("main") or a sub-agent
        // (e.g. otel-instrumenter / otel-verifier / Explore). subagent_type is the readable
        // identity; strip the plugin prefix for brevity. Lets us tell conductor vs sub-agent
        // tool calls apart in the stream.
        const rawAgent = (event as { subagent_type?: string }).subagent_type;
        const agent = rawAgent ? rawAgent.replace(/^.*:/, "") : "main";
        const content = event.message.content;
        if (Array.isArray(content)) {
          let msgText = "";
          for (const block of content) {
            if (typeof block !== "object" || block === null || !("type" in block)) continue;
            const type = (block as { type: string }).type;
            if (type === "tool_use") {
              toolUses++;
              const b = block as { type: string; name: string; input: Record<string, unknown> };
              const detail = toolDetail(b.name, b.input);
              const elapsed = `${((Date.now() - start) / 1000).toFixed(0)}s`;
              console.log(`  [${app}|${agent}][${elapsed}] ${b.name}${detail}`);
            } else if (type === "text") {
              msgText += (block as { type: string; text: string }).text;
            }
          }
          // Keep the latest non-empty assistant prose as the running "final" message;
          // the result event below overrides it with the authoritative final text.
          if (msgText.trim()) finalOutput = msgText;
        }
      } else if (event.type === "result") {
        // `modelUsage` is the cumulative, per-model token total for the whole
        // session — keyed by model id so a sub-agent on a different tier is
        // costed correctly. (The top-level `usage` is only the final turn.)
        const modelUsage = (event as {
          modelUsage?: Record<
            string,
            {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            }
          >;
        }).modelUsage;
        if (modelUsage) {
          perModel = Object.entries(modelUsage).map(([m, u]) => ({
            model: m,
            tokens: {
              input_tokens: u.inputTokens ?? 0,
              output_tokens: u.outputTokens ?? 0,
              cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
              cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
            },
          }));
        }
        const cost = (event as { total_cost_usd?: number }).total_cost_usd;
        if (typeof cost === "number") sdkCostUsd = cost;
        if (event.subtype === "success" && typeof event.result === "string" && event.result.trim()) {
          finalOutput = event.result;
        }
      }
    }
  } catch (err) {
    // Socket drop after agent finishes is common on long runs — treat as completion
    // if the agent made tool calls (indicating it did work before the drop).
    if (toolUses > 0 && String(err).includes("socket connection was closed")) {
      console.log("  [connection dropped — treating as complete]");
    } else {
      throw err;
    }
  }

  if (sandboxDenials > 0) {
    console.log(`  [${app}|sandbox] blocked ${sandboxDenials} out-of-checkout access attempt(s)`);
  }

  // Persist the agent's final summary for the env_var_output criterion (see src/envvars.ts).
  writeFileSync(resolve(harnessRoot, "tmp", `agent-output.${app}.txt`), finalOutput);

  // Sum the per-model cumulative token totals for the run-wide breakdown.
  const tokenTotals = perModel.reduce(
    (acc, { tokens }) => ({
      input: acc.input + tokens.input_tokens,
      output: acc.output + tokens.output_tokens,
      cache_read: acc.cache_read + tokens.cache_read_input_tokens,
      cache_creation: acc.cache_creation + tokens.cache_creation_input_tokens,
    }),
    { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  );
  const cost = costFromModelUsage(perModel);

  return {
    duration_ms: Date.now() - start,
    tool_uses: toolUses,
    input_tokens: tokenTotals.input,
    output_tokens: tokenTotals.output,
    cache_read_input_tokens: tokenTotals.cache_read,
    cache_creation_input_tokens: tokenTotals.cache_creation,
    total_tokens:
      tokenTotals.input + tokenTotals.output + tokenTotals.cache_read + tokenTotals.cache_creation,
    cost,
    sdk_cost_usd: sdkCostUsd,
    model: resolvedModel,
    session_id: sessionId,
  };
}
