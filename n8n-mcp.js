import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

console.log(`[startup] process.env.PORT = "${process.env.PORT}"`);
const PORT = Number(process.env.PORT) || 3001;
console.log(`[startup] Binding to port ${PORT}`);

// ─── n8n Config ───────────────────────────────────────────────────────────────
const N8N_BASE_URL = process.env.N8N_BASE_URL || "https://alberti-ai.app.n8n.cloud";
const N8N_API_KEY  = process.env.N8N_API_KEY  || "";

// ─── Workflow catalogue — built from n8n API at startup ──────────────────────
// Only active workflows that have a webhook trigger are callable as MCP tools.
// Inactive or non-webhook workflows are listed via the `list_workflows` tool.

/** @type {Array<{id, name, webhookPath, description, inputHint}>} */
let webhookWorkflows = [];

/** @type {Array<{id, name, active, trigger}>} */
let allWorkflows = [];

// Maps node type → human-readable verb for auto-generated descriptions
const NODE_LABELS = {
  airtable:        "Airtable",
  googleCalendar:  "Google Calendar",
  googleSheets:    "Google Sheets",
  gmail:           "Gmail",
  openAi:          "OpenAI",
  anthropic:       "Anthropic Claude",
  telegram:        "Telegram",
  httpRequest:     "HTTP request",
  firecrawl:       "web scraping",
  agent:           "AI agent",
  code:            "custom logic",
  if:              "conditional branching",
  respondToWebhook:"webhook response",
};

function describeWorkflow(workflow) {
  const nodeTypes = [
    ...new Set(
      workflow.nodes
        .map(n => n.type?.split(".").pop())
        .filter(t => t && t !== "webhook" && t !== "respondToWebhook" && t !== "stickyNote")
    ),
  ];
  const labels = nodeTypes
    .map(t => NODE_LABELS[t] || t)
    .filter(Boolean)
    .slice(0, 5);

  return labels.length
    ? `Runs the "${workflow.name}" workflow. Uses: ${labels.join(", ")}.`
    : `Runs the "${workflow.name}" workflow.`;
}

function inferInputHint(workflow) {
  const allParams = workflow.nodes
    .flatMap(n => Object.keys(n.parameters || {}))
    .map(p => p.toLowerCase());

  const hints = [];
  if (allParams.some(p => p.includes("email") || p.includes("mail")))    hints.push("email");
  if (allParams.some(p => p.includes("date") || p.includes("time")))     hints.push("date/time");
  if (allParams.some(p => p.includes("name")))                            hints.push("name");
  if (allParams.some(p => p.includes("phone") || p.includes("tel")))     hints.push("phone");
  if (allParams.some(p => p.includes("id")))                             hints.push("id");
  return hints.length ? hints.join(", ") : "any relevant data";
}

async function loadWorkflows() {
  try {
    console.log("[n8n] Loading workflows from n8n API…");
    const res = await fetch(`${N8N_BASE_URL}/api/v1/workflows?limit=100`, {
      headers: { "X-N8N-API-KEY": N8N_API_KEY },
    });

    if (!res.ok) throw new Error(`n8n API responded ${res.status}`);
    const { data } = await res.json();

    allWorkflows = data.map(w => {
      const trigger = w.nodes.find(n =>
        ["webhook","scheduleTrigger","telegramTrigger","gmailTrigger","formTrigger","manualTrigger","executeWorkflowTrigger"]
          .some(t => n.type?.includes(t))
      );
      return {
        id:     w.id,
        name:   w.name,
        active: w.active,
        trigger: trigger?.type?.split(".").pop() || "unknown",
      };
    });

    // Only expose active webhook-triggered workflows as callable tools
    webhookWorkflows = data
      .filter(w => w.active)
      .flatMap(w => {
        const webhookNode = w.nodes.find(n => n.type === "n8n-nodes-base.webhook");
        if (!webhookNode) return [];
        const path = webhookNode.parameters?.path;
        if (!path) return [];
        return [{
          id:          w.id,
          name:        w.name,
          webhookPath: path,
          description: describeWorkflow(w),
          inputHint:   inferInputHint(w),
        }];
      });

    console.log(`[n8n] Loaded ${allWorkflows.length} total, ${webhookWorkflows.length} callable via webhook`);
    webhookWorkflows.forEach(w => console.log(`  ✅ ${w.name} → /webhook/${w.webhookPath}`));
  } catch (err) {
    console.error("[n8n] Failed to load workflows:", err.message);
  }
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "dopamine-agency-n8n",
    version: "2.0.0",
  });

  // ── Tool: list_workflows ─────────────────────────────────────────────────────
  server.tool(
    "list_workflows",
    "Lists all n8n workflows with their status, trigger type, and whether they can be called as tools.",
    {},
    async () => {
      if (!allWorkflows.length) await loadWorkflows();
      const callableIds = new Set(webhookWorkflows.map(w => w.id));
      const lines = allWorkflows.map(w =>
        `• [${w.active ? "ACTIVE" : "inactive"}] ${w.name} (trigger: ${w.trigger})${callableIds.has(w.id) ? " ✅ callable" : ""}`
      );
      return {
        content: [{
          type: "text",
          text: `n8n Workflows (${allWorkflows.length} total, ${webhookWorkflows.length} callable):\n\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // ── Tool: reload_workflows ───────────────────────────────────────────────────
  server.tool(
    "reload_workflows",
    "Refreshes the workflow list from n8n. Use this if workflows have been added or changed.",
    {},
    async () => {
      await loadWorkflows();
      return {
        content: [{
          type: "text",
          text: `Reloaded. ${allWorkflows.length} total workflows, ${webhookWorkflows.length} callable via webhook.`,
        }],
      };
    }
  );

  // ── Tool: run_workflow ───────────────────────────────────────────────────────
  server.tool(
    "run_workflow",
    `Executes any active n8n webhook workflow by name or ID. Dynamically selects the right workflow based on the context. Pass the workflow name (or part of it) and a payload object with the relevant data. Current callable workflows: ${webhookWorkflows.map(w => `"${w.name}"`).join(", ") || "(loading…)"}`,
    {
      workflow_name: z.string().describe(
        "The workflow name or partial name to run (e.g. 'Confirm Booking', 'Reserve table', 'Find reservation')"
      ),
      payload: z.record(z.unknown()).optional().describe(
        "Key-value data to send to the workflow (e.g. { email, name, date, id })"
      ),
    },
    async ({ workflow_name, payload = {} }) => {
      if (!webhookWorkflows.length) await loadWorkflows();

      // Fuzzy match by name
      const query = workflow_name.toLowerCase();
      const match = webhookWorkflows.find(w =>
        w.name.toLowerCase().includes(query) || query.includes(w.name.toLowerCase().split(" ")[0])
      );

      if (!match) {
        const available = webhookWorkflows.map(w => `• ${w.name}`).join("\n");
        return {
          content: [{
            type: "text",
            text: `No active webhook workflow found matching "${workflow_name}".\n\nAvailable workflows:\n${available}`,
          }],
        };
      }

      try {
        console.log(`[n8n] Running workflow "${match.name}" → /webhook/${match.webhookPath}`, payload);
        const res = await fetch(`${N8N_BASE_URL}/webhook/${match.webhookPath}`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        });

        const text = await res.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }

        return {
          content: [{
            type: "text",
            text: `Workflow "${match.name}" executed (HTTP ${res.status}).\n\nResponse:\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Error running workflow "${match.name}": ${err.message}`,
          }],
        };
      }
    }
  );

  // ── Auto-generate one dedicated tool per active webhook workflow ──────────
  // This lets Voiceflow/Claude pick the right tool directly without run_workflow
  for (const wf of webhookWorkflows) {
    const toolName = wf.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60);

    server.tool(
      toolName,
      `${wf.description} Expected inputs: ${wf.inputHint}.`,
      {
        payload: z.record(z.unknown()).optional().describe(
          `Data to send to the "${wf.name}" workflow. Include: ${wf.inputHint}.`
        ),
      },
      async ({ payload = {} }) => {
        try {
          console.log(`[n8n] ${toolName} → /webhook/${wf.webhookPath}`, payload);
          const res = await fetch(`${N8N_BASE_URL}/webhook/${wf.webhookPath}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          });
          const text = await res.text();
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          return {
            content: [{
              type: "text",
              text: `${wf.name} completed (HTTP ${res.status}).\n\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
          };
        }
      }
    );
  }

  return server;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = createMcpExpressApp({ host: "0.0.0.0" });
app.set("trust proxy", 1);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
}));

const transports = {};

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "dopamine-agency n8n MCP server",
    version: "2.0.0",
    status: "running",
    activeSessions: Object.keys(transports).length,
    workflowsLoaded: allWorkflows.length,
    callableTools: webhookWorkflows.length,
    endpoints: { streamableHttp: `${base}/mcp`, sse_legacy: `${base}/sse` },
  });
});

// ── Streamable HTTP — /mcp (Voiceflow / modern clients) ──────────────────────
app.all("/mcp", async (req, res) => {
  console.log(`[MCP] ${req.method} from ${req.ip}`);
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          console.log(`[MCP] Session initialized: ${sid}`);
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) { console.log(`[MCP] Session closed: ${sid}`); delete transports[sid]; }
      };
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: missing or invalid session" }, id: null });
  } catch (err) {
    console.error("[MCP] Error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ── Legacy SSE — /sse + /messages ─────────────────────────────────────────────
app.get("/sse", async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);
  res.setHeader("X-Accel-Buffering", "no");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  try {
    await createMcpServer().connect(transport);
  } catch (err) {
    console.error("[SSE] connect error:", err);
    delete transports[transport.sessionId];
    if (!res.headersSent) res.status(500).end();
  }
});

app.post("/messages", async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!(transport instanceof SSEServerTransport))
    return res.status(400).json({ error: "Session not found. Connect to /sse first." });
  await transport.handlePostMessage(req, res, req.body);
});

app.use((err, req, res, _next) => {
  console.error("[Error]", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
await loadWorkflows(); // pre-load at startup so tools are ready on first connect

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Dopamine Agency n8n MCP server running on port ${PORT}`);
  console.log(`   Streamable HTTP → http://0.0.0.0:${PORT}/mcp`);
  console.log(`   SSE legacy      → http://0.0.0.0:${PORT}/sse`);
});

process.on("SIGINT", async () => {
  for (const [sid, t] of Object.entries(transports)) {
    try { await t.close(); } catch {}
    delete transports[sid];
  }
  process.exit(0);
});
