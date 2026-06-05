# MaternalGuard UI sidecar (Python)

A small Python MCP server that renders the interactive **MaternalGuard Morning Huddle** dashboard inside Prompt Opinion's chat using the `prefab-ui` library. Same pattern that LoopGuard Passport (2nd-place winner) used to render its in-chat UI.

## Why this is a separate server

Prompt Opinion's in-chat UI rendering requires `prefab-ui` and `fastmcp[apps]`, which are Python-only. The main MaternalGuard MCP server is TypeScript. Rather than port everything to Python, this sidecar handles only the UI surface. It does not duplicate clinical logic. It reads patient data directly from the workspace FHIR store (via the SHARP context the platform forwards) and routes user button clicks back to the existing TypeScript server's write tools (`ProposeMaternalAction`, `UpdateMaternalAction`).

## Architecture

Two MCP servers, both attached to the same Prompt Opinion agent (e.g. Prenatal Visit Prep):

```
                Prompt Opinion agent
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
  MaternalGuard MCP             MaternalGuard UI
  (TypeScript, port 5000)       (Python, port 5001)
  9 tools:                      1 tool:
    AssessMaternalRisk            OpenMaternalDashboard
    ScreenSocialDeterminants    (returns PrefabApp)
    GenerateCarePlan            buttons call back into the
    InterpretLabTrends          TS server via CallTool
    PredictNeonatalImpact
    MaternalPanelScan
    ProposeMaternalAction
    ListMaternalActions
    UpdateMaternalAction
```

When the user types "morning huddle" or "show me the cohort dashboard", the agent calls `OpenMaternalDashboard`. The Python sidecar reads the cohort from FHIR, classifies urgency, and returns a `PrefabApp` that Prompt Opinion renders as interactive UI. When the clinician clicks Approve / Reject / Save Edits / Activate / Dismiss, the button's `on_click` fires a `CallTool` action that invokes `UpdateMaternalAction` on the TypeScript server.

## Run locally

```
cd ui-server
pip install -r requirements.txt
python maternal_dashboard_server.py
```

Server starts on port 5001 by default. Tunnel with ngrok:

```
ngrok http 5001
```

## Register in Prompt Opinion

Add a second MCP server entry to your agent:

- **URL**: `https://<ngrok-or-deployment-url>/mcp`
- **Authentication Type**: None (or API Key if you set MCP_API_KEY)
- **Requires Patient Data Access**: enabled (forwards SHARP headers)

Make sure both MaternalGuard MCP (TS) and MaternalGuard UI (this sidecar) are attached to Prenatal Visit Prep so the dashboard's buttons can call back into the TS tools.

## Test prompts

In the agent chat:

- `Open the morning huddle dashboard.`
- `Show me the cohort triage queue.`
- `Who needs attention today?`

The agent should call `OpenMaternalDashboard` and the platform should render the visual dashboard inline. You can then click the Approve / Reject / Save Edits / Activate / Dismiss buttons directly.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port to bind | 5001 |
| `TRANSPORT` | MCP transport | streamable-http |
| `HOST` | Bind address | 0.0.0.0 |
| `MCP_API_KEY` | Optional API key. When set, callers must send matching X-API-Key. | unset |
| `MATERNALGUARD_BUNDLED_PATIENT_IDS` | Comma-separated FHIR Patient IDs forming the cohort. | empty (uses the selected patient only) |

## Deploy to Render

```
# from repo root
git push render main
```

Or upload via Render's UI using `render.yaml`. Set `MATERNALGUARD_BUNDLED_PATIENT_IDS` to your real workspace UUIDs after deploy.

## What this sidecar does NOT do

- It does NOT duplicate the urgency classification rules in a clinically authoritative way. The Python `_classify_urgency` mirrors the TypeScript version in `src/clinical/urgency-classifier.ts`; keep them in sync if you change the rules. The TypeScript version is canonical.
- It does NOT write to FHIR directly. All write operations route through the TypeScript server via `CallTool` actions on button clicks.
- It does NOT replace the TypeScript MCP server. Both are required for the full experience.

## Why this exists

Two of the three top winners (LookCloser, LoopGuard) shipped interactive UI alongside their MCP servers. Chat-only tools score lower on Magnus's "interactable interface is more akin to a realistic workflow" criterion. This sidecar closes that gap without throwing away the TypeScript codebase.
