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

// Single source of truth for the server version so /health and the MCP
// handshake never drift out of sync.
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as { version: string };
const SERVER_VERSION = pkg.version;

// Deduped set of FHIR bearer JWTs seen during this server lifetime.
// Populated under MATERNALGUARD_DEBUG_ARGS so an operator can grep the
// token out of the terminal for Postman. Deduped so a session that
// fires 4+ requests (initialize / notifications / tools/list / tool
// calls) only prints the same 1330-char JWT once. Reset per server
// restart, so restarts always re-print the current token.
const SEEN_BEARERS = new Set<string>();

// Most-recent bearer seen this run, served at /debug/bearer under
// DEBUG_ARGS so the operator can grab a clean copy in the browser
// without terminal wrapping mangling the JWT.
let LATEST_BEARER: string | null = null;

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

// Reviewer reproduction guide, published Model Card, and root redirect.
// Served straight from the container's ./static tree so the same deployment
// answers /mcp AND resolves the URLs every Provenance references. The paths
// map 1:1 to the URLs baked into MATERNALGUARD_MODEL_CARD_{JSON,MARKDOWN}_URL
// in src/clinical/fhir-builders.ts, so a viewer clicking the Model Card link
// on a Provenance lands on real content, not a 404.
//
// long-lived cache-control on the DSI files matches the "immutable per
// version" contract: the URLs are versionless, but the versioned copy is
// tracked in git — bumping MATERNALGUARD_DSI_VERSION + editing the file +
// redeploying is what changes what these URLs serve.
const STATIC_ROOT = path.join(__dirname, "static");
app.get("/", (_, res) => res.redirect(302, "/guide"));
app.get("/guide", (_, res) => {
  res
    .set("cache-control", "public, max-age=300")
    .sendFile(path.join(STATIC_ROOT, "guide", "index.html"));
});
app.use(
  "/guide",
  express.static(path.join(STATIC_ROOT, "guide"), {
    maxAge: "5m",
    fallthrough: false,
  }),
);
app.get("/dsi/model-card.json", (_, res) => {
  res
    .set("content-type", "application/json; charset=utf-8")
    .set("cache-control", "public, max-age=3600")
    .sendFile(path.join(STATIC_ROOT, "dsi", "model-card.json"));
});
app.get("/dsi/model-card.md", (_, res) => {
  res
    .set("content-type", "text/markdown; charset=utf-8")
    .set("cache-control", "public, max-age=3600")
    .sendFile(path.join(STATIC_ROOT, "dsi", "model-card.md"));
});

// /admin/bearer — production-safe replacement for the /debug/bearer
// endpoint. Same UI (dark page with select-all textarea + Copy button)
// but the gate is the existing MCP_API_KEY instead of the DEBUG_ARGS
// env flag. This avoids the previous "flip env, restart, grab, flip
// back, restart" workflow whenever the Prompt Opinion workspace session
// rotates its bearer (roughly hourly).
//
// Auth: either header X-API-Key: <MCP_API_KEY>, OR query ?key=<MCP_API_KEY>
// so the bookmark https://<host>/admin/bearer?key=<MCP_API_KEY> works.
// Returns 404 (not 401) on wrong/missing key so the endpoint is not
// even discoverable to a random scanner.
//
// Blast radius: the bearer is a workspace-scoped Supabase JWT that
// expires when Prompt Opinion refreshes the session (~1 hour). An
// attacker who obtained BOTH the URL and the MCP_API_KEY could grab
// short-lived FHIR access on this workspace. Rotating MCP_API_KEY
// rotates that surface. Acceptable for a solo-developer hackathon
// deployment; NOT for a multi-tenant production.
app.get("/admin/bearer", (req, res) => {
  const expectedApiKey = process.env["MCP_API_KEY"];
  const providedApiKey =
    req.headers["x-api-key"] ??
    (typeof req.query["key"] === "string" ? req.query["key"] : undefined);
  if (!expectedApiKey || providedApiKey !== expectedApiKey) {
    return res.status(404).send("Not found");
  }
  const bearer = LATEST_BEARER;
  const wantsJson = req.headers["accept"]?.toString().includes("application/json");
  if (!bearer) {
    if (wantsJson) {
      return res.status(200).json({ bearer: null, note: "no bearer captured yet; trigger any Prompt Opinion tool call first" });
    }
    return res
      .status(200)
      .set("content-type", "text/html; charset=utf-8")
      .send(
        `<!doctype html><meta charset="utf-8"><body style="font:14px/1.5 system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#111">
        <h2>No bearer captured yet</h2>
        <p>Trigger any Prompt Opinion tool call first (send any prompt in a chat where MaternalGuard is registered), then reload.</p>
        </body>`,
      );
  }
  if (wantsJson) {
    return res.status(200).json({ bearer, length: bearer.length });
  }
  const safe = bearer.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MaternalGuard bearer</title><style>
html,body{margin:0;padding:0;background:#0f172a;color:#e2e8f0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
main{max-width:900px;margin:0 auto;padding:40px 24px}h1{margin:0 0 8px;font-size:20px;color:#f8fafc}
p{margin:0 0 20px;color:#94a3b8}
textarea{width:100%;min-height:200px;background:#020617;color:#22d3ee;border:1px solid #334155;border-radius:8px;padding:12px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box;white-space:pre;overflow:auto;word-break:break-all}
.row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
button{background:#22d3ee;color:#0f172a;border:none;padding:10px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px}
button:hover{background:#67e8f9}button.sec{background:#334155;color:#e2e8f0}
.ok{color:#4ade80;font-weight:600;margin-left:8px}
.meta{margin-top:24px;padding:12px 16px;background:#1e293b;border-radius:8px;border-left:3px solid #22d3ee;font-size:13px}
code{background:#020617;padding:2px 6px;border-radius:3px;color:#22d3ee}
</style></head><body><main>
<h1>Current FHIR bearer for Postman</h1>
<p>Paste into the <code>bearerToken</code> variable in the MaternalGuard Postman collection.</p>
<textarea id="tok" readonly onclick="this.select()">${safe}</textarea>
<div class="row">
<button id="copy">Copy to clipboard</button>
<button class="sec" onclick="location.reload()">Refresh (grab newer)</button>
<span id="msg" class="ok" style="display:none">Copied</span>
</div>
<div class="meta"><div><strong>Length:</strong> ${bearer.length} chars</div>
<div><strong>Starts:</strong> <code>${safe.slice(0, 20)}...</code></div>
<div><strong>Ends:</strong> <code>...${safe.slice(-20)}</code></div>
<div style="margin-top:8px;color:#94a3b8">Token rotates on Prompt Opinion session refresh. If Postman 401s, reload this page.</div></div>
</main><script>
document.getElementById('copy').onclick=async()=>{const ta=document.getElementById('tok');try{await navigator.clipboard.writeText(ta.value)}catch{ta.select();document.execCommand('copy')}const m=document.getElementById('msg');m.style.display='inline';setTimeout(()=>{m.style.display='none'},1500)};
</script></body></html>`;
  res.set("content-type", "text/html; charset=utf-8").send(html);
});

app.get("/debug/bearer", (_, res) => {
  // Local-only helper for grabbing the current FHIR bearer JWT for the
  // Postman collection. Rendered as a browser page with a Copy button
  // so the operator does not have to select-and-copy the token out of
  // the terminal (where terminal line-wrap and Postman's "Secrets
  // Detected" flow both produce a subtly wrong paste that returns 401).
  //
  // Gated on MATERNALGUARD_DEBUG_ARGS=true so it is inert in any shared
  // deployment. The endpoint returns 404 otherwise so the URL is not
  // even discoverable. Never enable DEBUG_ARGS on Railway/production.
  if (process.env["MATERNALGUARD_DEBUG_ARGS"] !== "true") {
    return res.status(404).send("Not found");
  }
  const bearer = LATEST_BEARER;
  if (!bearer) {
    return res
      .status(200)
      .set("content-type", "text/html; charset=utf-8")
      .send(
        `<!doctype html><meta charset="utf-8"><body style="font:14px/1.5 system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#111">
        <h2 style="margin:0 0 12px">No bearer captured yet</h2>
        <p>The server has not seen an <code>X-FHIR-Access-Token</code> header yet.</p>
        <ol>
          <li>Open Prompt Opinion in your browser.</li>
          <li>Send any prompt (even "hi") in a chat where MaternalGuard is registered.</li>
          <li>Reload this page.</li>
        </ol>
        </body>`,
      );
  }
  // Never HTML-escape into JS by concatenation. The bearer is
  // base64url + JWT dots so it cannot contain HTML metacharacters,
  // but be defensive anyway.
  const safe = bearer.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MaternalGuard bearer</title>
<style>
  html,body{margin:0;padding:0;background:#0f172a;color:#e2e8f0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
  main{max-width:900px;margin:0 auto;padding:40px 24px}
  h1{margin:0 0 8px;font-size:20px;color:#f8fafc}
  p{margin:0 0 20px;color:#94a3b8}
  textarea{width:100%;min-height:200px;background:#020617;color:#22d3ee;border:1px solid #334155;border-radius:8px;padding:12px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box;white-space:pre;overflow:auto;word-break:break-all}
  .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  button{background:#22d3ee;color:#0f172a;border:none;padding:10px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px}
  button:hover{background:#67e8f9}
  button.sec{background:#334155;color:#e2e8f0}
  button.sec:hover{background:#475569}
  .ok{color:#4ade80;font-weight:600;margin-left:8px}
  .meta{margin-top:24px;padding:12px 16px;background:#1e293b;border-radius:8px;border-left:3px solid #22d3ee;font-size:13px}
  code{background:#020617;padding:2px 6px;border-radius:3px;color:#22d3ee}
</style>
</head>
<body>
<main>
  <h1>Current FHIR bearer for Postman</h1>
  <p>Paste this into the <code>bearerToken</code> variable in the MaternalGuard Postman collection.</p>
  <textarea id="tok" readonly onclick="this.select()">${safe}</textarea>
  <div class="row">
    <button id="copy">Copy to clipboard</button>
    <button class="sec" onclick="location.reload()">Refresh (grab newer)</button>
    <span id="msg" class="ok" style="display:none">Copied</span>
  </div>
  <div class="meta">
    <div><strong>Length:</strong> ${bearer.length} chars</div>
    <div><strong>Starts:</strong> <code>${safe.slice(0, 20)}...</code></div>
    <div><strong>Ends:</strong> <code>...${safe.slice(-20)}</code></div>
    <div style="margin-top:8px;color:#94a3b8">Token rotates when the Prompt Opinion session refreshes. If you see 401 in Postman, come back here and Copy again.</div>
  </div>
</main>
<script>
document.getElementById('copy').onclick = async () => {
  const ta = document.getElementById('tok');
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch { ta.select(); document.execCommand('copy'); }
  const msg = document.getElementById('msg');
  msg.style.display = 'inline';
  setTimeout(() => { msg.style.display = 'none'; }, 1500);
};
</script>
</body>
</html>`;
  res.set("content-type", "text/html; charset=utf-8").send(html);
});

app.get("/health", async (_, res) => {
  // Tool list is derived from the tools barrel at request time, so it
  // stays in sync as tools are added or removed. MaternalPanelScan is
  // env-gated and only surfaces when MATERNALGUARD_ENABLE_PANEL_SCAN=true.
  const toolNames = Object.keys(tools).filter((name) => {
    if (name === "MaternalPanelScanToolInstance") {
      return process.env["MATERNALGUARD_ENABLE_PANEL_SCAN"] === "true";
    }
    return true;
  }).map((k) => k.replace(/ToolInstance$/, ""));
  res.json({
    status: "healthy",
    name: "MaternalGuard MCP Server",
    version: SERVER_VERSION,
    prefabRendererMode: PREFAB_RENDERER_MODE,
    tools: toolNames,
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
    // Log presence of patient-id, not the value — the raw SHARP identifier
    // is PHI-equivalent and must never hit stdout (see no-PHI-in-logs
    // guarantee in README).
    const rawPatientIdHeader = req.headers["x-patient-id"];
    const hasPatientIdHeader = !!rawPatientIdHeader;
    // Default: PRESENT/MISSING (PHI hygiene for shared deployments).
    // With MATERNALGUARD_DEBUG_ARGS=true, log the actual UUID so an
    // operator can copy it straight into the Postman collection's
    // `patientId` variable without hunting through browser URLs.
    const patientIdDisplay =
      process.env["MATERNALGUARD_DEBUG_ARGS"] === "true"
        ? String(rawPatientIdHeader ?? "MISSING")
        : hasPatientIdHeader
          ? "PRESENT"
          : "MISSING";
    console.log(
      `[MCP] method=${method} | x-patient-id=${patientIdDisplay} | x-fhir-server-url=${fhirUrl || "MISSING"}`,
    );
    const rawToken = req.headers["x-fhir-access-token"];
    const hasToken = !!rawToken;
    const tokenLen = rawToken ? String(rawToken).length : 0;

    // Print the FHIR bearer once per unique value under DEBUG_ARGS.
    // Fires on ANY request type (initialize / notifications / tools/list
    // / tools/call) so an operator does not need to trigger an actual
    // tool call to see the token — a plain "hi" message that only hits
    // initialize + tools/list is enough. Dedupe by value so a session
    // that fires 4 requests does not spam the terminal with 4 copies of
    // the same 1330-char JWT; when the session refreshes and mints a
    // new token, the new one prints once.
    if (hasToken) {
      // Always update LATEST_BEARER so /debug/bearer serves the most
      // recent token even outside DEBUG_ARGS mode. The endpoint itself
      // is DEBUG_ARGS-gated.
      LATEST_BEARER = String(rawToken);
    }
    if (
      process.env["MATERNALGUARD_DEBUG_ARGS"] === "true" &&
      hasToken &&
      !SEEN_BEARERS.has(String(rawToken))
    ) {
      SEEN_BEARERS.add(String(rawToken));
      console.log(
        `[MCP]   bearer(copy from http://localhost:${port}/debug/bearer or from here)=${rawToken}`,
      );
    }

    if (req.body?.params?.name) {
      // Log only the KEYS of the arguments; values may include PHI (patient
      // IDs, clinician notes, free-text rationale). Enable value logging by
      // setting MATERNALGUARD_DEBUG_ARGS=true; keep OFF in production.
      //
      // EXCEPTION: log server-generated resource UUIDs (taskId, flagId) as
      // values. These are NOT PHI — they are opaque identifiers minted by
      // the FHIR server — and having them in the log is the fastest way to
      // paste into the Postman validation collection to verify a write
      // actually persisted. patientId is intentionally excluded because it
      // maps back to a person; use x-patient-id=PRESENT/MISSING for that.
      const args = req.body.params.arguments || {};
      const argKeys = Object.keys(args);
      const idBits: string[] = [];
      if (typeof args.taskId === "string" && args.taskId) idBits.push(`taskId=${args.taskId}`);
      if (typeof args.flagId === "string" && args.flagId) idBits.push(`flagId=${args.flagId}`);
      const idsPart = idBits.length ? ` ids=[${idBits.join(",")}]` : "";
      if (process.env["MATERNALGUARD_DEBUG_ARGS"] === "true") {
        // Bearer already printed once at the top-level [MCP] method= line
        // via the SEEN_BEARERS dedupe — no need to repeat it here.
        console.log(`[MCP]   tool=${req.body.params.name} args=${JSON.stringify(args)} token=${hasToken ? `YES(len=${tokenLen})` : "NO"}`);
      } else {
        console.log(`[MCP]   tool=${req.body.params.name} argKeys=[${argKeys.join(",")}]${idsPart} token=${hasToken ? `YES(len=${tokenLen})` : "NO"}`);
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
        version: SERVER_VERSION,
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
          "ACTION DRAFTING (write tool): If the user asks to draft, propose, create, queue, write up, log, record, file, or flag any follow-up action, task, order, review, referral, escalation, or chart flag for a patient, you MUST call ProposeMaternalAction. Examples: 'assess maternal risk for this patient and draft the appropriate follow-up actions', 'propose an action for this patient', 'create a Task for X', 'flag this pattern for the MFM service', 'what should we do about her rising BP, record it'. Do NOT narrate the care plan as free text in place of the call; the returned draft Task (and optional Flag) IS the deliverable. Loop and call ProposeMaternalAction once per distinct action (RED same-day items first, then YELLOW, then GREEN). Always restate 'Clinician review required before any action.' after the calls.",
          "",
          "For action coordination on EXISTING drafts (list pending, approve, reject, edit owner, change due date, activate flag, dismiss flag), use ListMaternalActions (read) and UpdateMaternalAction (edit) directly. Use ProposeMaternalAction only to CREATE new drafts. No 5-tool prep is required for any of the three action tools.",
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
    // Log only the message. The raw Error object can include the axios
    // request config (bearer token) or an Express body reference; use the
    // same redaction the other error paths already use.
    console.error(
      `[MCP] error handling request: ${error instanceof Error ? error.message : String(error)}`,
    );
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
