import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace } from "@opentelemetry/api";

let provider: NodeTracerProvider | undefined;

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return headers;
}

export function initTracing(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "https://api.honeycomb.io";
  const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "");

  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "instrumentation-skill-harness" }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register();
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown();
}

export function getTracer() {
  return trace.getTracer("instrumentation-skill-harness");
}
