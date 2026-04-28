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

// ─── Config ───────────────────────────────────────────────────────────────────
const N8N_BASE_URL = process.env.N8N_BASE_URL || "https://alberti-ai.app.n8n.cloud";
const N8N_API_KEY  = process.env.N8N_API_KEY  || "";

// ─── Workflow catalogue ───────────────────────────────────────────────────────
let webhookWorkflows = [];
let allWorkflows = [];

const NODE_LABELS = {
  airtable: "Airtable", googleCalendar: "Google Calendar",
  googleSheets: "Google Sheets", gmail: "Gmail",
  openAi: "OpenAI", anthropic: "Anthropic Claude",
  telegram: "Telegram", httpRequest: "HTTP request",
  firecrawl: "web scraping", agent: "AI agent",
  code: "custom logic", if: "conditional branching",
};

function describeWorkflow(workflow) {
  const labels = [...new Set(
    workflow.nodes.map(n => n.type?.split(".").pop())
      .filter(t => t && !["webhook","respondToWebhook","stickyNote"].includes(t))
  )].map(t => NODE_LABELS[t] || t).slice(0, 5);
  return labels.length
    ? `Runs the "${workflow.name}" workflow. Uses: ${labels.join(", ")}.`
    : `Runs the "${workflow.name}" workflow.`;
}

function inferInputHint(workflow) {
  const allParams = workflow.nodes.flatMap(n => Object.keys(n.parameters || {})).map(p => p.toLowerCase());
  const hints = [];
  if (allParams.some(p => p.includes("email") || p.includes("mail"))) hints.push("email");
  if (allParams.some(p => p.includes("date") || p.includes("time")))  hints.push("date/time");
  if (allParams.some(p => p.includes("name")))                         hints.push("name");
  if (allParams.some(p => p.includes("phone") || p.includes("tel")))  hints.push("phone");
  if (allParams.some(p => p.includes("id")))                          hints.push("id");
  return hints.length ? hints.join(", ") : "any relevant data";
}

async function loadWorkflows() {
  try {
    console.log("[n8n] Loading workflows…");
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
      return { id: w.id, name: w.name, active: w.active, trigger: trigger?.type?.split(".").pop() || "unknown" };
    });

    webhookWorkflows = data.filter(w => w.active).flatMap(w => {
      const webhookNode = w.nodes.find(n => n.type === "n8n-nodes-base.webhook");
      if (!webhookNode) return [];
      const path = webhookNode.parameters?.path;
      if (!path) return [];
      return [{ id: w.id, name: w.name, webhookPath: path, description: describeWorkflow(w), inputHint: inferInputHint(w) }];
    });

    console.log(`[n8n] ${allWorkflows.length} total, ${webhookWorkflows.length} callable`);
    webhookWorkflows.forEach(w => console.log(`  ✅ ${w.name} → /webhook/${w.webhookPath}`));
  } catch (err) {
    console.error("[n8n] Failed to load workflows:", err.message);
  }
}

// ─── Webhook helper ───────────────────────────────────────────────────────────
async function callWebhook(path, payload = {}) {
  const res = await fetch(`${N8N_BASE_URL}/webhook/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, ok: res.ok, data: parsed };
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "dopamine-agency-n8n", version: "3.0.0" });

  // ════════════════════════════════════════════════════════════════════════════
  // KATARINA BAKOVIĆ — AI MAKEUP CONCIERGE TOOLS
  // These 5 tools map directly to her booking workflows and cover the full
  // client lifecycle: availability → booking → confirmation → change → cancel
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1. check_availability ──────────────────────────────────────────────────
  server.tool(
    "check_availability",
    `Check Katarina's real-time availability for a specific date and time before confirming a booking.
     Always call this FIRST when a client proposes a date/time.
     Returns available slots or confirms if the requested time is free.
     Uses the Google Calendar availability engine workflow.`,
    {
      date: z.string().describe("Date to check in Croatian short format (e.g. '15.5.' or '15.5.2026')"),
      time: z.string().optional().describe("Specific time to check (e.g. '10:00'). Omit to get all free slots for that day."),
      service: z.string().optional().describe("Service requested (e.g. 'vjenčanje', 'matura', 'svakodnevna šminka')"),
    },
    async ({ date, time, service }) => {
      console.log(`[tool] check_availability date=${date} time=${time}`);
      try {
        // Try the active checkavailability webhook first, then getavailableslots
        const result = await callWebhook("checkavailability", { date, time, service });
        if (result.ok) {
          const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
          return { content: [{ type: "text", text: `Availability for ${date}${time ? ` at ${time}` : ""}:\n\n${msg}` }] };
        }
        // Fallback to the availability engine
        const result2 = await callWebhook("getavailableslots", { date, time, service });
        const msg2 = typeof result2.data === "string" ? result2.data : JSON.stringify(result2.data, null, 2);
        return { content: [{ type: "text", text: `Available slots for ${date}:\n\n${msg2}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Could not check availability: ${err.message}. Please ask Katarina directly to confirm.` }] };
      }
    }
  );

  // ── 2. create_booking ──────────────────────────────────────────────────────
  server.tool(
    "create_booking",
    `Create a new makeup booking for Katarina Baković.
     Call this after availability is confirmed and the client has provided all required details.
     Saves the booking to Airtable, creates a Google Calendar event, and sends a confirmation email with confirm/cancel links.
     Required: name, contact (phone or email), service, date, time, location.`,
    {
      name:     z.string().describe("Client's full name (e.g. 'Ana Horvat')"),
      contact:  z.string().describe("Client's phone number or email address"),
      service:  z.string().describe("Makeup service requested (e.g. 'vjenčanje', 'matura', 'svakodnevna šminka', 'photo shoot')"),
      date:     z.string().describe("Appointment date in short Croatian format (e.g. '15.5.' or '15.5.2026')"),
      time:     z.string().describe("Appointment time (e.g. '10:00')"),
      location: z.string().optional().describe("Location/address for the appointment"),
      notes:    z.string().optional().describe("Any additional notes or special requests from the client"),
    },
    async ({ name, contact, service, date, time, location, notes }) => {
      console.log(`[tool] create_booking for ${name} — ${service} on ${date} at ${time}`);
      try {
        const result = await callWebhook("booking-lead", { name, contact, service, date, time, location, notes });
        const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
        return {
          content: [{
            type: "text",
            text: result.ok
              ? `✅ Booking created for ${name}!\n\nService: ${service}\nDate: ${date} at ${time}\n${location ? `Location: ${location}\n` : ""}\nDetails:\n${msg}`
              : `⚠️ Booking submission returned status ${result.status}:\n${msg}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error creating booking: ${err.message}` }] };
      }
    }
  );

  // ── 3. confirm_booking ─────────────────────────────────────────────────────
  server.tool(
    "confirm_booking",
    `Confirm a pending booking by Booking ID.
     Use this when a client confirms their appointment (e.g. they clicked the confirm link or say "yes I confirm").
     Updates the booking status in Airtable to Confirmed.
     Requires the Booking ID (format: BK + 6 digits, e.g. 'BK123456').`,
    {
      booking_id: z.string().describe("Booking ID in format BK + 6 digits (e.g. 'BK123456')"),
    },
    async ({ booking_id }) => {
      console.log(`[tool] confirm_booking id=${booking_id}`);
      try {
        const result = await callWebhook("confirm-booking", { id: booking_id });
        const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
        return {
          content: [{
            type: "text",
            text: result.ok
              ? `✅ Booking ${booking_id} confirmed! The appointment has been updated in Airtable.\n\n${msg}`
              : `⚠️ Could not confirm booking ${booking_id} (status ${result.status}):\n${msg}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error confirming booking: ${err.message}` }] };
      }
    }
  );

  // ── 4. find_and_cancel_booking ─────────────────────────────────────────────
  server.tool(
    "find_and_cancel_booking",
    `Find a client's existing booking and cancel/delete it.
     Use this when a client wants to cancel their appointment.
     First searches Google Calendar by client name and date, then deletes the event.
     If only the name is provided, returns all upcoming bookings for that client so they can pick the right one.`,
    {
      name:    z.string().describe("Client's name as it appears in the booking"),
      date:    z.string().optional().describe("Appointment date to narrow down (e.g. '15.5.')"),
      confirm: z.boolean().optional().describe("Set to true to actually delete. Default false (only finds and returns the booking)."),
    },
    async ({ name, date, confirm = false }) => {
      console.log(`[tool] find_and_cancel name=${name} date=${date} confirm=${confirm}`);
      try {
        if (!confirm) {
          // First find the booking
          const result = await callWebhook("canceltable", { name, date, action: "find" });
          const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
          return {
            content: [{
              type: "text",
              text: `Found bookings for "${name}":\n\n${msg}\n\nTo cancel, call this tool again with confirm: true.`,
            }],
          };
        } else {
          // Delete the booking
          const result = await callWebhook("deleteflow", { name, date });
          const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
          return {
            content: [{
              type: "text",
              text: result.ok
                ? `✅ Booking for ${name}${date ? ` on ${date}` : ""} has been cancelled and removed from the calendar.\n\n${msg}`
                : `⚠️ Could not cancel booking (status ${result.status}):\n${msg}`,
            }],
          };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── 5. change_booking ──────────────────────────────────────────────────────
  server.tool(
    "change_booking",
    `Reschedule an existing booking to a new date and/or time.
     Use this when a client wants to move their appointment.
     Finds the existing Google Calendar event by client name and old date, then updates it to the new date/time.
     Always check availability for the new slot before calling this.`,
    {
      name:     z.string().describe("Client's name as it appears in the booking"),
      old_date: z.string().describe("Current appointment date (e.g. '15.5.')"),
      old_time: z.string().optional().describe("Current appointment time (e.g. '10:00')"),
      new_date: z.string().describe("New date to move to (e.g. '20.5.')"),
      new_time: z.string().describe("New time to move to (e.g. '14:00')"),
    },
    async ({ name, old_date, old_time, new_date, new_time }) => {
      console.log(`[tool] change_booking ${name}: ${old_date} → ${new_date} ${new_time}`);
      try {
        const result = await callWebhook("change reservation", {
          name, old_date, old_time, new_date, new_time,
        });
        const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
        return {
          content: [{
            type: "text",
            text: result.ok
              ? `✅ Booking for ${name} moved from ${old_date}${old_time ? ` ${old_time}` : ""} to ${new_date} at ${new_time}.\n\n${msg}`
              : `⚠️ Could not reschedule booking (status ${result.status}):\n${msg}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error rescheduling: ${err.message}` }] };
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // GENERIC / UTILITY TOOLS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_workflows",
    "Lists all n8n workflows with their status, trigger type, and whether they are callable as MCP tools.",
    {},
    async () => {
      if (!allWorkflows.length) await loadWorkflows();
      const callableIds = new Set(webhookWorkflows.map(w => w.id));
      const lines = allWorkflows.map(w =>
        `• [${w.active ? "ACTIVE" : "inactive"}] ${w.name} (trigger: ${w.trigger})${callableIds.has(w.id) ? " ✅ callable" : ""}`
      );
      return { content: [{ type: "text", text: `n8n Workflows (${allWorkflows.length} total, ${webhookWorkflows.length} callable):\n\n${lines.join("\n")}` }] };
    }
  );

  server.tool(
    "reload_workflows",
    "Refreshes the workflow list from n8n. Use after adding or activating workflows.",
    {},
    async () => {
      await loadWorkflows();
      return { content: [{ type: "text", text: `Reloaded. ${allWorkflows.length} total, ${webhookWorkflows.length} callable.` }] };
    }
  );

  server.tool(
    "run_workflow",
    `Run any active n8n webhook workflow by name or partial name. Use this as a fallback when a dedicated tool doesn't exist. Available: ${webhookWorkflows.map(w => `"${w.name}"`).join(", ") || "(loading…)"}`,
    {
      workflow_name: z.string().describe("Workflow name or partial name"),
      payload: z.any().optional().describe("Data to send to the workflow"),
    },
    async ({ workflow_name, payload = {} }) => {
      if (!webhookWorkflows.length) await loadWorkflows();
      const query = workflow_name.toLowerCase();
      const match = webhookWorkflows.find(w =>
        w.name.toLowerCase().includes(query) || query.includes(w.name.toLowerCase().split(" ")[0])
      );
      if (!match) {
        return { content: [{ type: "text", text: `No workflow matching "${workflow_name}".\nAvailable:\n${webhookWorkflows.map(w => `• ${w.name}`).join("\n")}` }] };
      }
      try {
        const result = await callWebhook(match.webhookPath, payload);
        const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
        return { content: [{ type: "text", text: `"${match.name}" executed (HTTP ${result.status}).\n\n${msg}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // Auto-generate one dedicated tool per remaining active webhook workflow
  // (skipping the ones already covered by the 5 Katarina-specific tools above)
  const coveredPaths = new Set(["booking-lead","confirm-booking","deleteflow","canceltable","change reservation","checkavailability","getavailableslots"]);
  for (const wf of webhookWorkflows.filter(w => !coveredPaths.has(w.webhookPath))) {
    const toolName = wf.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
    server.tool(
      toolName,
      `${wf.description} Expected inputs: ${wf.inputHint}.`,
      { payload: z.any().optional().describe(`Data for "${wf.name}". Include: ${wf.inputHint}.`) },
      async ({ payload = {} }) => {
        try {
          const result = await callWebhook(wf.webhookPath, payload);
          const msg = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
          return { content: [{ type: "text", text: `${wf.name} (HTTP ${result.status}).\n\n${msg}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
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

app.get("/", (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "dopamine-agency n8n MCP server",
    version: "3.0.0",
    status: "running",
    activeSessions: Object.keys(transports).length,
    workflowsLoaded: allWorkflows.length,
    callableTools: webhookWorkflows.length,
    makeupConciergeTools: ["check_availability","create_booking","confirm_booking","find_and_cancel_booking","change_booking"],
    endpoints: { streamableHttp: `${base}/mcp`, sse_legacy: `${base}/sse` },
  });
});

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
        onsessioninitialized: (sid) => { console.log(`[MCP] Session: ${sid}`); transports[sid] = transport; },
      });
      transport.onclose = () => { const sid = transport.sessionId; if (sid) delete transports[sid]; };
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

app.get("/sse", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  try { await createMcpServer().connect(transport); }
  catch (err) { delete transports[transport.sessionId]; if (!res.headersSent) res.status(500).end(); }
});

app.post("/messages", async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!(transport instanceof SSEServerTransport))
    return res.status(400).json({ error: "Session not found." });
  await transport.handlePostMessage(req, res, req.body);
});

app.use((err, req, res, _next) => {
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

await loadWorkflows();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Dopamine Agency n8n MCP v3 on port ${PORT}`);
  console.log(`   /mcp → Voiceflow (Streamable HTTP)`);
  console.log(`   /sse → legacy SSE`);
  console.log(`   Makeup concierge tools: check_availability, create_booking, confirm_booking, find_and_cancel_booking, change_booking`);
});

process.on("SIGINT", async () => {
  for (const [sid, t] of Object.entries(transports)) { try { await t.close(); } catch {} delete transports[sid]; }
  process.exit(0);
});
