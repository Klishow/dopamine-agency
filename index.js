import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const PORT = 3000;

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

// ─── MCP Server ───────────────────────────────────────────────────────────────
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

// ─── Express HTTP Server with SSE Transport ───────────────────────────────────
const app = express();
app.use(express.json());

// Active SSE transports keyed by session ID
const transports = {};

// SSE connection endpoint — clients connect here to open a session
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

// Message endpoint — clients POST JSON-RPC messages here
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!transport) {
    return res.status(400).json({ error: "Session not found. Connect to /sse first." });
  }

  await transport.handlePostMessage(req, res);
});

// Health check
app.get("/", (req, res) => {
  res.json({
    name: "dopamine-agency MCP server",
    version: "1.0.0",
    status: "running",
    endpoints: {
      sse: `http://localhost:${PORT}/sse`,
      messages: `http://localhost:${PORT}/messages`,
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ Dopamine Agency MCP server running on port ${PORT}`);
  console.log(`   SSE endpoint  → http://localhost:${PORT}/sse`);
  console.log(`   POST endpoint → http://localhost:${PORT}/messages`);
});
