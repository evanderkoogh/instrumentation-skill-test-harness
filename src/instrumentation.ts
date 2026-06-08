import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AgentMetrics {
  duration_ms: number;
  tool_uses: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export async function runInstrumentation(
  app: string,
  apiKey: string
): Promise<AgentMetrics> {
  const promptPath = resolve(__dirname, "..", ".instrument-prompt.md");
  const prompt = readFileSync(promptPath, "utf8");
  const repoDir = resolve(__dirname, "..", "checkouts", app);

  const start = Date.now();
  let toolUses = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of query({
    prompt,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      cwd: repoDir,
      maxTurns: 100,
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
        OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${apiKey}`,
        OTEL_SERVICE_NAME: `${app}-instrumentation`,
      },
    },
  })) {
    if (event.type === "assistant") {
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
          }
        }
      }
      process.stdout.write(".");
    } else if (event.type === "result") {
      inputTokens = event.usage?.input_tokens ?? 0;
      outputTokens = event.usage?.output_tokens ?? 0;
      process.stdout.write("\n");
    }
  }

  return {
    duration_ms: Date.now() - start,
    tool_uses: toolUses,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}
