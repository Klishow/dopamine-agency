import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Client profile database — keyed by Telegram chat ID
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

const transport = new StdioServerTransport();
await server.connect(transport);
