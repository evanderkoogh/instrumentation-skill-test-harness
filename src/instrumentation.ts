import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
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
    default:        return "";
  }
}

export interface AgentMetrics {
  duration_ms: number;
  tool_uses: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model: string;
  session_id: string;
}

export interface SkillVersion {
  branch: string;
  sha: string;
  commit: string;
}

export async function runInstrumentation(
  app: string,
  apiKey: string,
  model?: string,
  skill?: SkillVersion
): Promise<AgentMetrics> {
  const promptPath = resolve(__dirname, "..", `.instrument-prompt.${app}.md`);
  const prompt = readFileSync(promptPath, "utf8");
  const repoDir = resolve(__dirname, "..", "checkouts", app);

  const start = Date.now();
  let toolUses = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let resolvedModel = model ?? "unknown";
  let sessionId = "unknown";

  try {
    for await (const event of query({
      prompt,
      options: {
        allowedTools: ["Read", "Write", "Edit", "Bash"],
        cwd: repoDir,
        maxTurns: 150,
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
          ].filter(Boolean).join(","),
        },
      },
    })) {
      if (event.type === "system" && event.subtype === "init") {
        resolvedModel = event.model;
        sessionId = event.session_id;
      } else if (event.type === "assistant") {
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              (block as { type: string }).type === "tool_use"
            ) {
              toolUses++;
              const b = block as { type: string; name: string; input: Record<string, unknown> };
              const detail = toolDetail(b.name, b.input);
              const elapsed = `${((Date.now() - start) / 1000).toFixed(0)}s`;
              console.log(`  [${app}|${resolvedModel}][${elapsed}] ${b.name}${detail}`);
            }
          }
        }
      } else if (event.type === "result") {
        inputTokens = event.usage?.input_tokens ?? 0;
        outputTokens = event.usage?.output_tokens ?? 0;
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

  return {
    duration_ms: Date.now() - start,
    tool_uses: toolUses,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    model: resolvedModel,
    session_id: sessionId,
  };
}
