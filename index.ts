import "dotenv/config";
import * as tools from "./src/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { IMcpTool } from "./src/IMcpTool";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";

// The prefab-ui renderer as a self-contained singlefile HTML (Vite bundle
// with the entire React app + AppBridge inlined; no external script/style
// references). This matches what FastMCP's Python provider serves at
// ui://prefab/renderer.html. Because everything is inlined, the iframe's
// CSP does NOT need to whitelist a CDN — script-src 'self' is enough.
// Read once at boot from disk; keep in memory for the lifetime of the
// process (~6.5MB).
const PREFAB_RENDERER_HTML = fs.readFileSync(
  path.join(__dirname, "static", "prefab-renderer.html"),
  "utf8",
);

const app = express();
const port = process.env["PORT"] || 5000;

app.use(cors());
app.use(express.json());

app.get("/health", async (_, res) => {
  res.json({
    status: "healthy",
    name: "MaternalGuard MCP Server",
    version: "1.7.0-singlefile-renderer",
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
    const rawToken = req.headers["x-fhir-access-token"];
    const hasToken = !!rawToken;
    const tokenLen = rawToken ? String(rawToken).length : 0;
    if (req.body?.params?.name) {
      // Log only the KEYS of the arguments; values may include PHI (patient
      // IDs, clinician notes, free-text rationale). Enable value logging by
      // setting MATERNALGUARD_DEBUG_ARGS=true; keep OFF in production.
      const argKeys = Object.keys(req.body.params.arguments || {});
      if (process.env["MATERNALGUARD_DEBUG_ARGS"] === "true") {
        console.log(`[MCP]   tool=${req.body.params.name} args=${JSON.stringify(req.body.params.arguments || {})} token=${hasToken ? `YES(len=${tokenLen})` : "NO"}`);
      } else {
        console.log(`[MCP]   tool=${req.body.params.name} argKeys=[${argKeys.join(",")}] token=${hasToken ? `YES(len=${tokenLen})` : "NO"}`);
      }
    } else {
      // Log presence of patient-id, not the value, so patient identifiers do
      // not leak into stdout logs.
      const hasPatientId = !!req.headers["x-patient-id"];
      console.log(`[MCP]   non-tool method; token=${hasToken ? `YES(len=${tokenLen})` : "NO"} patient-id=${hasPatientId ? "PRESENT" : "MISSING"}`);
    }

    const server = new McpServer(
      {
        name: "MaternalGuard",
        version: "1.0.0",
      },
      {
        instructions: [
          "MaternalGuard is a maternal-health decision-support MCP server. All outputs are draft and require clinician review before any action.",
          "",
          "TOOL CHOICE (especially in Prompt Opinion): If the user asks for the morning huddle, dashboard, GUI, interactive UI, visual triage board, cohort view, panel view, or anything like 'who needs attention today' / 'show me the visual' / 'open the board' — you MUST call OpenMaternalDashboard. It returns an interactive in-chat UI with per-patient cards, urgency bands, and Approve/Reject/Save-edits/Activate/Dismiss buttons wired to UpdateMaternalAction.",
          "",
          "Do NOT use AssessMaternalRisk, InterpretLabTrends, MaternalPanelScan, or GenerateCarePlan for those requests. Those tools return JSON summaries only. They do NOT render UI. If the user's ask is about a visual dashboard or interactive workflow, prefer OpenMaternalDashboard.",
          "",
          "For a full CLINICAL BRIEF ('prep me for tomorrow', 'summarize this patient', 'cite guidelines for X'), run the 5 data tools (AssessMaternalRisk, InterpretLabTrends, ScreenSocialDeterminants, GenerateCarePlan, PredictNeonatalImpact) plus SearchSources, and produce the structured brief. That flow is separate from the dashboard flow.",
          "",
          "For action coordination on drafts (list pending, propose, approve, reject, edit owner, change due date, activate flag, dismiss flag), use ListMaternalActions, ProposeMaternalAction, and UpdateMaternalAction directly. No 5-tool prep is required for those.",
          "",
          "Every response must end with: 'Clinician review required before any action.'",
        ].join("\n"),
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

    // Renderer resource: served at ui://prefab/renderer.html, the URI that
    // OpenMaternalDashboard's _meta.ui.resourceUri points to. The platform
    // fetches this via resources/read and mounts it inside a sandboxed
    // iframe in the chat. Because the HTML has everything inlined (React,
    // renderer, styles, AppBridge), the iframe does NOT need any external
    // origins allowed in its CSP. We therefore omit resourceDomains, which
    // matches FastMCP's default when the renderer is fully self-contained.
    // mimeType MUST be "text/html;profile=mcp-app" (the profile param is
    // Prompt Opinion's discovery signal for app-renderer resources; plain
    // "text/html" is not recognized).
    server.registerResource(
      "prefab-renderer",
      "ui://prefab/renderer.html",
      {
        title: "Prefab UI Renderer",
        description: "Prefab UI renderer iframe target for MCP App tools",
        mimeType: "text/html;profile=mcp-app",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html;profile=mcp-app",
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
