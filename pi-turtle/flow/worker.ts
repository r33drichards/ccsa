import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.ts";

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
