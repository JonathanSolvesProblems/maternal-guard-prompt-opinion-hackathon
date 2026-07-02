import "dotenv/config";
import * as tools from "./src/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { IMcpTool } from "./src/IMcpTool";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The prefab-ui renderer HTML we serve at ui://prefab/renderer.html. We
// keep BOTH shapes on hand and pick one at boot via env var, so we can
// A/B without re-downloading:
//
//   MATERNALGUARD_PREFAB_RENDERER_MODE=singlefile  (default, current)
//     Vite singlefile: entire React app + AppBridge as one giant inline
//     <script type="module">. Origin-agnostic, no CDN dependency, but
//     blocked by Prompt Opinion's parent-page CSP because their
//     script-src directive is origin-based and does not allow inline.
//
//   MATERNALGUARD_PREFAB_RENDERER_MODE=cdn
//     Stub HTML that references <script src="https://cdn.jsdelivr.net/
//     npm/@prefecthq/prefab-ui@0.20.2/dist/app/renderer.js">. Only works
//     if Prompt Opinion extends the iframe CSP to allow jsDelivr — which
//     it should when the resource carries _meta.ui.csp.resourceDomains
//     naming that origin (FastMCP wire vocabulary).
//
// Both are cached in module scope so first-request latency is amortised.
const PREFAB_SINGLEFILE_HTML = fs.readFileSync(
  path.join(__dirname, "static", "prefab-renderer.html"),
  "utf8",
);

const PREFAB_CDN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prefab</title>
    <script type="module" crossorigin src="https://cdn.jsdelivr.net/npm/@prefecthq/prefab-ui@0.20.2/dist/app/renderer.js"></script>
    <link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/npm/@prefecthq/prefab-ui@0.20.2/dist/app/renderer.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const PREFAB_RENDERER_MODE =
  process.env["MATERNALGUARD_PREFAB_RENDERER_MODE"] === "cdn" ? "cdn" : "singlefile";

const PREFAB_RENDERER_HTML =
  PREFAB_RENDERER_MODE === "cdn" ? PREFAB_CDN_HTML : PREFAB_SINGLEFILE_HTML;

// Compute the sha256 of the ONE inline <script>...</script> body inside
// the singlefile HTML. CSP hashes cover the exact bytes between the tags,
// UTF-8, no whitespace normalisation. We ship this hash on _meta.ui.csp
// in every plausible field name (FastMCP's shape uses domain lists only,
// so the hash keys are speculative; Prompt Opinion ignores unknown keys).
const INLINE_SCRIPT_HASHES: string[] = (() => {
  const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(PREFAB_SINGLEFILE_HTML)) !== null) {
    const body = m[1];
    if (!body || body.trim() === "") continue;
    out.push("sha256-" + crypto.createHash("sha256").update(body, "utf8").digest("base64"));
  }
  return out;
})();

console.log(
  `[MaternalGuard] Prefab renderer mode=${PREFAB_RENDERER_MODE}; inline-script hashes:`,
  INLINE_SCRIPT_HASHES.map((h) => h.slice(0, 24) + "..."),
);

const app = express();
const port = process.env["PORT"] || 5000;

app.use(cors());
app.use(express.json());

app.get("/health", async (_, res) => {
  res.json({
    status: "healthy",
    name: "MaternalGuard MCP Server",
    version: "1.8.0-csp-hashes-and-domains",
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

    // Renderer resource, mounted at ui://prefab/renderer.html — the URI
    // OpenMaternalDashboard's _meta.ui.resourceUri points to. Prompt
    // Opinion fetches this via resources/read and mounts it in an iframe
    // whose src is srcdoc="", so the iframe inherits the parent chat
    // page's CSP. That CSP is origin-based and rejects inline scripts, so
    // the resource _meta needs to tell Prompt Opinion which external
    // origins to add to script-src (via resourceDomains) AND which inline
    // script hashes to permit (via scriptHashes and its several observed
    // spellings). We publish the union of every plausible spelling so the
    // platform picks whichever it reads and ignores the rest.
    const cspMeta = {
      ui: {
        csp: {
          // FastMCP-native camelCase wire vocabulary (domain lists only).
          connectDomains: [
            "https://cdn.jsdelivr.net",
            "https://raw.githubusercontent.com",
          ],
          resourceDomains: [
            "https://cdn.jsdelivr.net",
            "https://raw.githubusercontent.com",
          ],
          frameDomains: [],
          baseUriDomains: [],
          // snake_case mirror in case a host reads Python-side naming.
          connect_domains: ["https://cdn.jsdelivr.net"],
          resource_domains: ["https://cdn.jsdelivr.net"],
          // Literal CSP directive keys, in case the host parses them as-is.
          "script-src": ["'self'", "https://cdn.jsdelivr.net", ...INLINE_SCRIPT_HASHES.map((h) => `'${h}'`)],
          "style-src": ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
          "img-src": ["'self'", "https://cdn.jsdelivr.net", "data:", "blob:"],
          "font-src": ["'self'", "https://cdn.jsdelivr.net", "data:"],
          "connect-src": ["'self'", "https://cdn.jsdelivr.net"],
          // Multiple observed spellings for hash-based script allowlisting.
          scriptHashes: INLINE_SCRIPT_HASHES,
          script_hashes: INLINE_SCRIPT_HASHES,
          inlineScriptHashes: INLINE_SCRIPT_HASHES,
          inline_script_hashes: INLINE_SCRIPT_HASHES,
        },
      },
    };

    server.registerResource(
      "prefab-renderer",
      "ui://prefab/renderer.html",
      {
        title: "Prefab UI Renderer",
        description: "Prefab UI renderer iframe target for MCP App tools",
        mimeType: "text/html;profile=mcp-app",
        _meta: cspMeta,
      },
      async (uri) => ({
        _meta: cspMeta,
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html;profile=mcp-app",
            text: PREFAB_RENDERER_HTML,
            _meta: cspMeta,
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
