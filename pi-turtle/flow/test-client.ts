import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const arena = readFileSync("/tmp/sort-arena.yaml", "utf8");
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "server.ts"], env: process.env as Record<string,string> });
const client = new Client({ name: "test", version: "0" });
await client.connect(transport);
console.log("TOOLS:", (await client.listTools()).tools.map((t:any)=>t.name).join(", "));
console.log("RESOURCES:", (await client.listResources()).resources.map((r:any)=>r.uri).join(", "));
const trig:any = await client.callTool({ name: "research_trigger", arguments: { arena } });
const { workflowId } = JSON.parse(trig.content[0].text);
console.log("TRIGGERED:", workflowId);
for (;;) {
  await new Promise(r=>setTimeout(r, 8000));
  const st:any = await client.callTool({ name: "research_status", arguments: { workflowId } });
  const o = JSON.parse(st.content[0].text);
  console.log("STATUS:", o.type, o.score||"");
  if (o.type !== "running") {
    console.log("RETURN:", JSON.stringify({ type: o.type, msg: o.msg, files: o.files ? Object.keys(o.files) : undefined }));
    if (o.files && o.files["prog.lua"]) console.log("prog.lua head:\n" + o.files["prog.lua"].split("\n").slice(0,6).join("\n"));
    break;
  }
}
await client.close();
process.exit(0);
