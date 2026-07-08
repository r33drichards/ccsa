// Pure, deterministic compaction helpers shared by the workflow (a cheap gate + the
// sent-view builder — both must be replay-stable) and the `compact` activity (the actual
// eviction + summarization). No I/O here, so it is safe to import into workflow code.
//
// Algorithm: threshold-triggered rolling summary + tool-pair-safe verbatim tail. Bind to
// glm-5.2's window (Ollama glm-5.2:cloud = 976K) but run under a working cap for latency.
export const MODEL_WINDOW = 976000;                              // glm-5.2:cloud on Ollama; re-read if the tag changes
// Use most of the real 976K window (it was previously capped at 160K, which forced needless
// compaction at ~112K). WORKING_CAP reserves ~76K headroom for the completion output + the tool
// schema + the experiments ledger, all of which also sit inside the 976K context.
export const WORKING_CAP = 900000;
export const COMPACT_THRESHOLD = Math.floor(0.78 * WORKING_CAP); // ~702000 — compact at/above this
export const COMPACT_TARGET = Math.floor(0.50 * WORKING_CAP);    // 450000  — fold/evict down to this
export const TAIL_TOKEN_BUDGET = 300000;                         // recent est-tokens kept verbatim
export const MIN_TAIL_GROUPS = 3;                                // ...but always keep >= this many groups

export function toolsSchemaTok(tools: unknown): number { return Math.ceil(JSON.stringify(tools).length / 4); }

// deterministic ~4-chars/token estimate (+8 per-message role/framing overhead)
export function estMsg(m: any): number {
  const s = String(m?.content ?? "").length
    + (m?.tool_calls ? JSON.stringify(m.tool_calls).length : 0)
    + (m?.tool_call_id ? String(m.tool_call_id).length : 0);
  return Math.ceil(s / 4) + 8;
}
export function estTokens(view: any[], schemaTok: number): number {
  let t = schemaTok;
  for (const m of view) t += estMsg(m);
  return t;
}
// what we actually send: pinned system + first user, then the deterministic experiments
// ledger (keep-what-works memory, always present), then the rolling summary block (compaction
// byproduct, only once context grows large), then the live turns.
export function sendView(messages: any[], summary: string, ledger?: string): any[] {
  const head: any[] = [messages[0], messages[1]];
  if (ledger) head.push({ role: "system", content: "EXPERIMENTS LEDGER (a deterministic record of every program you have tested — your keep-what-works memory; do NOT repeat a rejected approach):\n" + ledger });
  if (summary) head.push({ role: "system", content: "CONVERSATION SUMMARY (compacted history; authoritative record of everything before the recent turns):\n" + summary });
  return head.concat(messages.slice(2));
}
// pure turn-group boundaries over msgs[start..]: an assistant(tool_calls) + its following tool
// messages is one atomic group; any other message is its own group. Cuts land only on boundaries.
export function groupsFrom(msgs: any[], start: number): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let i = start;
  while (i < msgs.length) {
    let j = i + 1;
    if (msgs[i].role === "assistant" && msgs[i].tool_calls) while (j < msgs.length && msgs[j].role === "tool") j++;
    groups.push({ start: i, end: j });
    i = j;
  }
  return groups;
}
