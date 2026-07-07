import { proxyActivities } from "@temporalio/workflow";
import type * as acts from "./activities.ts";

// Researcher-only workflow: input is an arena.yaml, output is the passing program.
const { research } = proxyActivities<typeof acts>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

export async function researchWorkflow(arena: string) {
  return await research(arena);
}
