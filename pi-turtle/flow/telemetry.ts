// OpenTelemetry for the worker + MCP server: metrics, traces, and logs, all pushed
// over OTLP/HTTP. A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (so local dev is
// unaffected). In prod it points at the otel-lgtm all-in-one (Prometheus + Tempo +
// Loki + Grafana), e.g. http://otel-lgtm.railway.internal:4318.
import { metrics, trace, SpanStatusCode, type Counter, type Span } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

let started = false;
export function initTelemetry(serviceName?: string): void {
  if (started) return;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return;
  started = true;
  const b = base.replace(/\/+$/, "");
  // Every process in this stack shares ONE service identity — "turtle-research" — so a single
  // selector covers the worker AND the MCP server: {service_name="turtle-research"} in Loki,
  // service_name="turtle-research" in Prometheus/Tempo. The per-process role (worker vs mcp)
  // is kept as a `service.component` attribute so it stays filterable without fragmenting
  // service_name. Previously each caller set service.name to "turtle-research-worker" /
  // "turtle-research-mcp", so {service_name="turtle-research"} matched 0 streams in Loki even
  // though logs were flowing — they were just under those two other service_name values.
  const component = (serviceName || "app").replace(/^turtle-research-/, "");
  const resource = resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME || "turtle-research",
    "service.namespace": "turtle-research",
    "service.component": component,
  });

  metrics.setGlobalMeterProvider(new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: b + "/v1/metrics" }), exportIntervalMillis: 15000 })],
  }));
  new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: b + "/v1/traces" }))],
  }).register();
  logs.setGlobalLoggerProvider(new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: b + "/v1/logs" }) })],
  }));
  console.error(`[otel] ${component}: metrics+traces+logs -> ${b} (service.name=${process.env.OTEL_SERVICE_NAME || "turtle-research"})`);
}

// ── metrics ──────────────────────────────────────────────────────────────────
// Instruments MUST be created lazily, AFTER initTelemetry() has registered the real
// MeterProvider. Unlike getTracer()/getLogger() (which return proxies that pick up the
// global provider on every call), a Counter created at module-load time binds permanently
// to whatever provider was global then — the no-op one, since this module is imported
// before initTelemetry runs — and silently never exports. So cache on first record().
let tokensCounter: Counter | undefined;
let callsCounter: Counter | undefined;
function counters(): { tokens: Counter; calls: Counter } {
  if (!tokensCounter || !callsCounter) {
    const meter = metrics.getMeter("turtle-research");
    tokensCounter = meter.createCounter("llm.tokens", { description: "LLM tokens consumed", unit: "{token}" });
    callsCounter = meter.createCounter("llm.calls", { description: "LLM API calls", unit: "{call}" });
  }
  return { tokens: tokensCounter, calls: callsCounter };
}
export function recordTokens(kind: string, model: string, usage: any): void {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || 0), c = Number(usage.completion_tokens || 0);
  const { tokens } = counters();
  if (p > 0) tokens.add(p, { kind, model, type: "prompt" });
  if (c > 0) tokens.add(c, { kind, model, type: "completion" });
}
export function recordCall(kind: string, model: string, status: "ok" | "error"): void {
  counters().calls.add(1, { kind, model, status });
}

// ── traces ───────────────────────────────────────────────────────────────────
const tracer = trace.getTracer("turtle-research");
// Run fn inside a span; records exceptions + sets error status automatically.
export async function withSpan<T>(name: string, attrs: Record<string, any>, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    try {
      span.setAttributes(attrs);
      const r = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e?.message ?? e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

// ── logs ─────────────────────────────────────────────────────────────────────
const logger = logs.getLogger("turtle-research");
export function emitLog(severity: "info" | "warn" | "error", body: string, attributes?: Record<string, any>): void {
  const n = severity === "error" ? SeverityNumber.ERROR : severity === "warn" ? SeverityNumber.WARN : SeverityNumber.INFO;
  logger.emit({ severityNumber: n, severityText: severity.toUpperCase(), body, attributes });
}
