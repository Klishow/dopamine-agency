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
          content: [
            {
              type: "text",
              text: `No client profile found for Telegram chat ID: ${chat_id}`,
            },
          ],
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

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    }
  );

  return server;
}

// ─── Express HTTP Server ──────────────────────────────────────────────────────
const app = express();

// CORS — allow all origins so Voiceflow, n8n, and any other cloud service can connect
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
}));

app.use(express.json());

// Active transports keyed by session ID
const transports = {};

// SSE endpoint — each client connection gets its own McpServer instance
app.get("/sse", async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(); // fresh instance per session

  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
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

// Health check
app.get("/", (req, res) => {
  const base = process.env.PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`;
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

app.listen(PORT, () => {
  console.log(`✅ Dopamine Agency MCP server running on port ${PORT}`);
  console.log(`   SSE endpoint  → http://localhost:${PORT}/sse`);
  console.log(`   POST endpoint → http://localhost:${PORT}/messages`);
});
