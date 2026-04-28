import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

// Log injected PORT immediately so Railway deploy logs confirm the value
console.log(`[startup] process.env.PORT = "${process.env.PORT}"`);
const PORT = Number(process.env.PORT) || 3000;
console.log(`[startup] Binding to port ${PORT}`);

// ─── Client Profile Database (keyed by Telegram chat ID) ─────────────────────
const clientProfiles = {
  "123456789": {
    name: "Carlos Méndez",
    niche: "E-commerce de ropa fitness",
    tone: "Energético y motivacional",
    language: "Español",
  },
  "987654321": {
    name: "Sofia Reyes",
    niche: "Coaching de vida y bienestar",
    tone: "Empático y cercano",
    language: "Español",
  },
  "111222333": {
    name: "John Smith",
    niche: "SaaS B2B / Productividad",
    tone: "Profesional y directo",
    language: "English",
  },
  "444555666": {
    name: "Laura Vásquez",
    niche: "Restaurante y gastronomía",
    tone: "Cálido y apetitoso",
    language: "Español",
  },
  "8650939350": {
    name: "Marin",
    niche: "Fitness",
    tone: "Energetic and motivating",
    language: "Croatian",
  },
};

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "dopamine-agency",
    version: "1.0.0",
  });

  server.tool(
    "get_client_profile",
    "Returns the client profile (name, niche, tone, language) for a given Telegram chat ID.",
    { chat_id: z.string().describe("The Telegram chat ID of the client") },
    async ({ chat_id }) => {
      const profile = clientProfiles[chat_id];
      if (!profile) {
        return {
          content: [{ type: "text", text: `No client profile found for Telegram chat ID: ${chat_id}` }],
        };
      }
      const output = [
        `Client Profile`,
        `──────────────`,
        `Name:     ${profile.name}`,
        `Niche:    ${profile.niche}`,
        `Tone:     ${profile.tone}`,
        `Language: ${profile.language}`,
      ].join("\n");
      return { content: [{ type: "text", text: output }] };
    }
  );

  return server;
}

// ─── Express App ─────────────────────────────────────────────────────────────
// createMcpExpressApp with host 0.0.0.0 skips localhost-only DNS rebinding
// protection so Railway's proxy can reach the server
const app = createMcpExpressApp({ host: "0.0.0.0" });

app.set("trust proxy", 1);

// CORS for Voiceflow, n8n, and any other cloud client
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
}));

// Active transports keyed by session ID
const transports = {};

// ── Health check — registered first so Railway probes always get 200 ─────────
app.get("/", (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "dopamine-agency MCP server",
    version: "1.0.0",
    status: "running",
    activeSessions: Object.keys(transports).length,
    endpoints: {
      streamableHttp: `${base}/mcp`,
      sse_legacy: `${base}/sse`,
    },
  });
});

// ── Streamable HTTP transport — /mcp (protocol 2025-11-25, used by Voiceflow) ─
app.all("/mcp", async (req, res) => {
  console.log(`[MCP] ${req.method} from ${req.ip}`);
  try {
    const sessionId = req.headers["mcp-session-id"];

    // Reuse existing session
    if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize POST
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
        if (sid && transports[sid]) {
          console.log(`[MCP] Session closed: ${sid}`);
          delete transports[sid];
        }
      };

      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing or invalid session" },
      id: null,
    });
  } catch (err) {
    console.error("[MCP] Error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ── Legacy SSE transport — /sse + /messages (protocol 2024-11-05) ─────────────
app.get("/sse", async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);
  res.setHeader("X-Accel-Buffering", "no");

  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  try {
    await createMcpServer().connect(transport);
  } catch (err) {
    console.error("[SSE] connect error:", err);
    delete transports[transport.sessionId];
    if (!res.headersSent) res.status(500).end();
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!(transport instanceof SSEServerTransport)) {
    console.warn(`[SSE] Unknown sessionId: ${sessionId}`);
    return res.status(400).json({ error: "Session not found. Connect to /sse first." });
  }

  await transport.handlePostMessage(req, res, req.body);
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error("[Error]", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Dopamine Agency MCP server running on port ${PORT}`);
  console.log(`   Streamable HTTP → http://0.0.0.0:${PORT}/mcp  (Voiceflow / n8n)`);
  console.log(`   SSE legacy      → http://0.0.0.0:${PORT}/sse`);
});

process.on("SIGINT", async () => {
  for (const [sid, t] of Object.entries(transports)) {
    try { await t.close(); } catch {}
    delete transports[sid];
  }
  process.exit(0);
});
