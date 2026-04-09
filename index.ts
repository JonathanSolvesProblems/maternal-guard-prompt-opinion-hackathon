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
    version: "1.0.0",
    tools: [
      "AssessMaternalRisk",
      "ScreenSocialDeterminants",
      "GenerateCarePlan",
      "InterpretLabTrends",
    ],
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = new McpServer(
      {
        name: "MaternalGuard",
        version: "1.0.0",
      },
      {
        capabilities: {
          extensions: {
            "ai.promptopinion/fhir-context": {},
          },
        },
      },
    );

    for (const tool of Object.values<IMcpTool>(tools)) {
      tool.registerTool(server, req);
    }

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
});
