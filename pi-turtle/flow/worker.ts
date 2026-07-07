import { NativeConnection, Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { initTelemetry, withSpan, emitLog } from "./telemetry.ts";
import * as rawActivities from "./activities.ts";

initTelemetry("turtle-research-worker"); // OTLP metrics+traces+logs (no-op unless OTEL_EXPORTER_OTLP_ENDPOINT set)

function wfId(): string {
  try { return Context.current().info.workflowExecution.workflowId; } catch { return ""; }
}
// Wrap every activity in a span (traces), tagged with the workflow id, and log failures.
const activities: Record<string, any> = {};
for (const [name, fn] of Object.entries(rawActivities)) {
  if (typeof fn !== "function") continue;
  activities[name] = (...args: any[]) =>
    withSpan(`activity.${name}`, { "activity.name": name, "workflow.id": wfId() }, () => (fn as any)(...args))
      .catch((e: any) => { emitLog("error", `activity ${name} failed: ${String(e?.message ?? e)}`, { "activity.name": name, "workflow.id": wfId() }); throw e; });
}

const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  taskQueue: "turtle",
  workflowsPath: new URL("./workflow.ts", import.meta.url).pathname,
  activities,
});
console.error(`[worker] running on taskQueue 'turtle' (temporal ${address})`);
await worker.run();
