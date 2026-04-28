import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;

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

// ─── MCP Server Factory (one instance per SSE session) ───────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "dopamine-agency",
    version: "1.0.0",
  });

  server.tool(
    "get_client_profile",
    "Returns the client profile (name, niche, tone, language) for a given Telegram chat ID.",
    {
      chat_id: z.string().describe("The Telegram chat ID of the client"),
    },
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
const app = express();

// Trust Railway's reverse proxy so req.protocol returns https
app.set("trust proxy", 1);

// ── Health check FIRST — before all middleware so Railway probes always get 200
app.get("/", (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "dopamine-agency MCP server",
    version: "1.0.0",
    status: "running",
    activeSessions: Object.keys(transports).length,
    endpoints: {
      sse: `${base}/sse`,
      messages: `${base}/messages`,
    },
  });
});

// CORS — allow all origins (Voiceflow, n8n, etc.)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
}));

app.use(express.json());

// Active transports keyed by session ID
const transports = {};

// SSE endpoint — fire-and-forget connect so the route handler returns immediately
app.get("/sse", (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();

  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  // Do NOT await — SSE stays open indefinitely; fire and forget
  server.connect(transport).catch((err) => {
    console.error(`[SSE] connect error:`, err);
    delete transports[transport.sessionId];
    if (!res.headersSent) res.status(500).end();
  });
});

// Message endpoint — receives JSON-RPC tool calls
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!transport) {
    console.warn(`[POST] Unknown sessionId: ${sessionId}`);
    return res.status(400).json({ error: "Session not found. Connect to /sse first." });
  }

  await transport.handlePostMessage(req, res);
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error("[Error]", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

// Bind explicitly to 0.0.0.0 so Railway's proxy can reach the process
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Dopamine Agency MCP server running on port ${PORT}`);
  console.log(`   SSE endpoint  → http://0.0.0.0:${PORT}/sse`);
  console.log(`   POST endpoint → http://0.0.0.0:${PORT}/messages`);
});
