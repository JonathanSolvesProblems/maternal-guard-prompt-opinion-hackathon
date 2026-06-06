import "dotenv/config";
import * as tools from "./src/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { IMcpTool } from "./src/IMcpTool";
import express from "express";
import cors from "cors";

const app = express();
const port = process.env["PORT"] || 5000;

app.use(cors());
app.use(express.json());

app.get("/health", async (_, res) => {
  res.json({
    status: "healthy",
    name: "MaternalGuard MCP Server",
    version: "1.4.1-prefab-renderer-resource",
    tools: [
      "AssessMaternalRisk",
      "ScreenSocialDeterminants",
      "GenerateCarePlan",
      "InterpretLabTrends",
      "PredictNeonatalImpact",
      ...(process.env["MATERNALGUARD_ENABLE_PANEL_SCAN"] === "true"
        ? ["MaternalPanelScan"]
        : []),
      "ProposeMaternalAction",
      "ListMaternalActions",
      "UpdateMaternalAction",
      "OpenMaternalDashboard",
    ],
  });
});

app.post("/mcp", async (req, res) => {
  // API key auth — only enforced when MCP_API_KEY env var is set (allows local dev without a key)
  const expectedApiKey = process.env["MCP_API_KEY"];
  if (expectedApiKey) {
    const providedApiKey = req.headers["x-api-key"];
    if (providedApiKey !== expectedApiKey) {
      console.log(`[MCP] auth rejected — provided x-api-key=${providedApiKey ? "MISMATCH" : "MISSING"}`);
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: invalid or missing X-API-Key header" },
        id: null,
      });
    }
  }

  try {
    const method = req.body?.method || "unknown";
    const fhirUrl = req.headers["x-fhir-server-url"];
    const patientId = req.headers["x-patient-id"];
    console.log(
      `[MCP] method=${method} | x-patient-id=${patientId || "MISSING"} | x-fhir-server-url=${fhirUrl || "MISSING"}`,
    );
    const hasToken = !!req.headers["x-fhir-access-token"];
    if (req.body?.params?.name) {
      console.log(`[MCP]   tool=${req.body.params.name} args=${JSON.stringify(req.body.params.arguments || {})} token=${hasToken ? "YES" : "NO"}`);
    }

    const server = new McpServer(
      {
        name: "MaternalGuard",
        version: "1.0.0",
      },
      {
        capabilities: {
          extensions: {
            "ai.promptopinion/fhir-context": {},
            // Candidate extension URIs for prefab-ui rendering. The platform
            // recognizes one of these (we hope) to mark this server as capable
            // of returning prefab apps. Declaring multiple is harmless; the
            // platform should ignore those it does not understand.
            "ai.promptopinion/prefab-ui": {},
            "ai.promptopinion/prefab": {},
            "ai.promptopinion/app": {},
            "prefab-ui": { version: "0.19" },
          },
        },
      },
    );

    for (const tool of Object.values<IMcpTool>(tools)) {
      tool.registerTool(server, req);
    }

    // Register the prefab renderer resource that tools/_meta/ui/resourceUri
    // points to. The platform fetches this resource via resources/read and
    // mounts the returned HTML inside an iframe in the chat. The HTML is a
    // tiny stub that loads the prefab renderer JS/CSS from jsDelivr; the
    // bundled renderer then receives our PrefabApp JSON via the platform's
    // postMessage bridge and draws the actual UI.
    const PREFAB_RENDERER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prefab</title>
  <link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/npm/@prefecthq/prefab-ui@0.19.1/dist/app/renderer.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" crossorigin src="https://cdn.jsdelivr.net/npm/@prefecthq/prefab-ui@0.19.1/dist/app/renderer.js"></script>
</body>
</html>`;

    server.registerResource(
      "prefab-renderer",
      "ui://prefab/renderer.html",
      {
        title: "Prefab UI Renderer",
        description: "Prefab UI renderer iframe target for MCP App tools",
        mimeType: "text/html",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html",
            text: PREFAB_RENDERER_HTML,
          },
        ],
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.log("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.listen(port, () => {
  console.log(`MaternalGuard MCP server listening on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`API key auth: ${process.env["MCP_API_KEY"] ? "ENABLED (X-API-Key required)" : "DISABLED (set MCP_API_KEY env var to enable)"}`);
});
