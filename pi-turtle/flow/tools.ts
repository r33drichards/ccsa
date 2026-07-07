// The agent's fixed action space, as OpenAI-shape function tools (glm via Ollama
// maps these to native tool_calls). The workflow dispatches each tool_call to an
// activity: turtle_sim -> turtleSim, run_js -> runJs. Pure module (workflow-safe).
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "turtle_sim",
      description:
        "Run your COMPLETE CC:Tweaked Lua turtle program against EVERY arena environment and get back the " +
        "per-invariant ok/FAIL log. This is the authority on success: you are done only when it reports 0 failed. " +
        "Submit the whole program each call.",
      parameters: {
        type: "object",
        properties: { program: { type: "string", description: "The complete CC:Tweaked Lua turtle program." } },
        required: ["program"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_js",
      description:
        "Evaluate JavaScript in the languages sandbox (persistent, isolated /work with the craftos engine and " +
        "the full skills tree). Use it to inspect the sandbox, read a skill file, or run the craftos engine " +
        "yourself before submitting. Returns only what you console.log(...). " +
        "`fs`, `craftos`, and `picat` are READY GLOBALS — call them directly (e.g. await fs.readFile(path,'utf8')). " +
        "There is NO module system: NEVER require('fs') or import anything — require/import are disabled and throw.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript to evaluate in the sandbox." } },
        required: ["code"],
      },
    },
  },
];
