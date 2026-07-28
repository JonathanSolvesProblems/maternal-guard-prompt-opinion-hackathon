# Testing the new MaternalGuard capabilities

Step-by-step verification for the additions made for the August production push: the deterministic urgency classifier, the FHIR draft-resource builders, the cohort `MaternalPanelScan` tool, and the governed write-back `ProposeMaternalAction` tool.

Everything below runs locally with ngrok pointing at your Prompt Opinion workspace.

## 0. Prerequisites

- Node 18 or higher installed (`node --version`).
- `npm install` already run in the repo root.
- ngrok installed and authenticated (`ngrok config add-authtoken ...` already done).
- A Prompt Opinion workspace with the existing MaternalGuard MCP server already registered.
- The existing Maria Santos bundle already imported.

## 1. Confirm the project builds clean

From the repo root:

```
npx tsc --noEmit
```

Expected: no output, exit code 0. If you see errors, the build is broken; do not proceed until it is clean.

## 2. Configure `.env` for the new tools

Copy `.env.example` to `.env` if you have not already, then add these lines:

```
MCP_API_KEY=<your existing secret>
MATERNALGUARD_ENABLE_PANEL_SCAN=true
MATERNALGUARD_BUNDLED_PATIENT_IDS=<comma-separated UUIDs, see step 4>
MATERNALGUARD_ENABLE_WRITEBACK=false
```

Leave `MATERNALGUARD_ENABLE_WRITEBACK=false` for now. You will flip it to `true` later in step 8 to test live writes.

## 3. Start the server

```
npm start
```

Expected console output:

```
MaternalGuard MCP server listening on port 5000
Health check: http://localhost:5000/health
MCP endpoint: http://localhost:5000/mcp
API key auth: ENABLED (X-API-Key required)
```

Hit `http://localhost:5000/health` in a browser. You should see the new tools listed:

```json
{
  "status": "healthy",
  "name": "MaternalGuard MCP Server",
  "version": "1.0.0",
  "tools": [
    "AssessMaternalRisk",
    "ScreenSocialDeterminants",
    "GenerateCarePlan",
    "InterpretLabTrends",
    "PredictNeonatalImpact",
    "MaternalPanelScan",
    "ProposeMaternalAction"
  ]
}
```

If `MaternalPanelScan` is missing from the list, `MATERNALGUARD_ENABLE_PANEL_SCAN` is not set to exactly `true` (case-sensitive string).

## 4. Import the additional cohort bundle into Prompt Opinion

In your Prompt Opinion workspace:

1. Open the FHIR Bundle Import tool.
2. Upload `test-cases/cohort-additional-patients-bundle.json`.
3. After import, check the patient picker. You should see three new patients in addition to Maria:
   - **Zhang, Lin** (born 1997-04-22) — stable normal pregnancy at 30 weeks. Expected band: GREEN.
   - **Okonkwo, Amara** (born 1991-09-03) — mild preeclampsia, stable, at 33 weeks. Expected band: YELLOW.
   - **Fisher, Rachel** (born 1994-11-30) — gestational diabetes only, fasting glucose 105, at 34 weeks. Expected band: YELLOW.
4. Open each patient and grab the FHIR Patient UUID from the URL or patient detail page. The server-assigned UUID is what you need for the env var, NOT the placeholder `lin-zhang-uuid` strings in the bundle JSON.
5. Set the env var in your local `.env`:
   ```
   MATERNALGUARD_BUNDLED_PATIENT_IDS=<maria-uuid>,<lin-uuid>,<amara-uuid>,<rachel-uuid>
   ```
6. Restart the server (`Ctrl+C`, then `npm start`) so the new env var is picked up.

## 5. Tunnel through ngrok and re-register

If you are using ngrok for the existing MCP server, restart it after the server restart:

```
ngrok http 5000
```

Update the MCP server URL in Prompt Opinion to the new ngrok URL plus `/mcp` (ngrok free rotates the URL on each restart).

## 6. Test MaternalPanelScan in Prompt Opinion

In the Prenatal Visit Prep agent (or any agent that has the MaternalGuard MCP server attached), send this prompt:

```
Run a panel scan and rank the cohort by urgency. Show me the RED and YELLOW patients first with their contributing signals.
```

**Expected tool calls visible:**
- `MaternalPanelScan` fires once (no patient context is needed because it operates on the bundled cohort).

**Expected output shape (JSON inside the agent's response):**

```json
{
  "disclaimer": "Decision support only. Clinician review required before any action.",
  "scannedAt": "<timestamp>",
  "cohortSize": 4,
  "cohortSource": "bundled patient list (live workspace enumeration is a future platform feature)",
  "filterBand": "ALL",
  "returnedCount": 4,
  "triageQueue": [
    {
      "patientId": "<maria-uuid>",
      "patientDisplay": "Santos, Maria",
      "urgency": {
        "band": "RED",
        "score": 150,
        "signals": [ ... rising BP, rising AST, falling platelets ... ],
        "patternFlags": ["HELLP-evolution"],
        "reviewBy": "today"
      },
      ...
    },
    {
      "patientId": "<amara-uuid>",
      "patientDisplay": "Okonkwo, Amara",
      "urgency": {
        "band": "YELLOW",
        "score": 45,
        "signals": [ ... hypertensive BP, proteinuria ... ],
        "reviewBy": "within 48 hours"
      }
    },
    {
      "patientId": "<rachel-uuid>",
      "patientDisplay": "Fisher, Rachel",
      "urgency": {
        "band": "YELLOW",
        "score": 10,
        "signals": [ ... fasting glucose above IADPSG ... ]
      }
    },
    {
      "patientId": "<lin-uuid>",
      "patientDisplay": "Zhang, Lin",
      "urgency": {
        "band": "GREEN",
        "score": 0,
        "signals": [],
        "reviewBy": "routine schedule"
      }
    }
  ]
}
```

**Pass criteria:**

- ✅ `MaternalPanelScan` tool call appears in the tool list.
- ✅ All 4 patients show up in `triageQueue`.
- ✅ Maria is RED with `patternFlags: ["HELLP-evolution"]`.
- ✅ Amara is YELLOW.
- ✅ Rachel is YELLOW (GDM signal).
- ✅ Lin is GREEN.
- ✅ Order in `triageQueue` is descending by `score`.

**Negative-control sanity check:** Lin should have an empty `signals` array. If she shows any signal, your urgency classifier is producing false positives.

## 7. Test ProposeMaternalAction in dry-run mode

With Maria selected as the patient, send this prompt to Prenatal Visit Prep:

```
Maria has an evolving HELLP pattern. Propose a maternal action: an urgent MFM consult, due in 24 hours, with a chart flag. Then I will review.
```

**Expected tool calls visible:**

- All 5 standard MaternalGuard tools fire (the agent gathers context).
- `SearchSources` fires 2 or 3 times for grounding.
- `ProposeMaternalAction` fires once.

**Expected output (dry-run):**

```json
{
  "writeMode": "dry-run",
  "writeEnabled": false,
  "note": "Set MATERNALGUARD_ENABLE_WRITEBACK=true to actually persist these drafts to the FHIR store.",
  "draftTask": {
    "resourceType": "Task",
    "status": "requested",
    "intent": "proposal",
    "priority": "urgent",
    "description": "...MFM consult... Rationale: ... Clinician review required before any action.",
    "for": { "reference": "Patient/<maria-uuid>" },
    "restriction": { "period": { "end": "<ISO date>" } }
  },
  "draftFlag": {
    "resourceType": "Flag",
    "status": "inactive",
    "category": [ ... "hellp-evolution" ... ],
    "code": { "text": "..." }
  },
  "editableCoordinationFields": [
    "ownerDisplay",
    "dueDate",
    "clinicianNote",
    "urgencyBand"
  ],
  "fixedClinicalFields": [
    "recommendation",
    "rationale",
    "guidelineReference"
  ]
}
```

**Pass criteria:**

- ✅ `writeMode` is `"dry-run"`.
- ✅ `draftTask.status` is `"requested"`.
- ✅ `draftFlag.status` is `"inactive"`.
- ✅ The `editableCoordinationFields` and `fixedClinicalFields` arrays are populated.
- ✅ No new Task or Flag appears in Maria's chart in Prompt Opinion (because writes are off).

## 8. Test ProposeMaternalAction in live write-back mode

**Important:** this writes draft resources into your workspace FHIR store. Only do this in a workspace you control.

1. Stop the server.
2. Flip the env var in `.env`:
   ```
   MATERNALGUARD_ENABLE_WRITEBACK=true
   ```
3. Restart the server (`npm start`).
4. Re-send the same prompt from step 7.

**Expected output (persisted):**

```json
{
  "writeMode": "persisted",
  "writeEnabled": true,
  "createdTaskId": "<server-assigned UUID>",
  "createdFlagId": "<server-assigned UUID>",
  "taskStatus": "requested (draft — awaiting clinician sign-off)",
  "flagStatus": "inactive (draft — awaiting clinician activation)",
  "nextStep": "A reviewing clinician must change Task.status from 'requested' to 'accepted' (or 'rejected') before this action takes effect."
}
```

**Pass criteria:**

- ✅ `writeMode` is `"persisted"`.
- ✅ A `createdTaskId` and `createdFlagId` are returned.
- ✅ In the Prompt Opinion patient detail page for Maria, a new Task resource with status `requested` is visible.
- ✅ A new Flag resource with status `inactive` is visible.
- ✅ A new Provenance resource is visible.

**Negative-control sanity check:** open one of the created resources and try to imagine editing the `rationale` text. The resource itself is editable in FHIR raw form, but the documented contract is that downstream UI must only expose the `editableCoordinationFields`. Confirm the contract by inspecting the response JSON.

## 9. Test the urgency classifier directly (optional)

If you want to verify the deterministic logic without going through Prompt Opinion, you can write a small standalone script. Create `scripts/test-classifier.ts`:

```typescript
import { classifyUrgency } from "../src/clinical/urgency-classifier";

const result = classifyUrgency({
  gestationalAgeWeeks: 32,
  bpReadings: [
    { date: "2026-03-01", systolicMmHg: 130, diastolicMmHg: 82 },
    { date: "2026-04-04", systolicMmHg: 148, diastolicMmHg: 95 },
  ],
  labReadings: [
    { code: "1920-8", display: "AST", value: 38, unit: "U/L", date: "2026-03-14" },
    { code: "1920-8", display: "AST", value: 54, unit: "U/L", date: "2026-04-04" },
    { code: "777-3",  display: "Platelets", value: 162, unit: "10*3/uL", date: "2026-03-14" },
    { code: "777-3",  display: "Platelets", value: 141, unit: "10*3/uL", date: "2026-04-04" },
  ],
});

console.log(JSON.stringify(result, null, 2));
```

Run it: `npx tsx scripts/test-classifier.ts`. Expected: band is RED, `patternFlags` contains `"HELLP-evolution"`, score is at least 80.

## 10. Test the FHIR builders directly (optional)

Similarly, you can sanity-check the FHIR resource shape without writing to a server:

```typescript
import { buildDraftTask, buildDraftFlag, buildProvenance } from "../src/clinical/fhir-builders";

const task = buildDraftTask({
  patientId: "test-uuid",
  recommendation: "Urgent MFM consult for HELLP evolution",
  rationale: "Rising AST (54), falling platelets (141), rising BP (148/95) at 32w.",
  urgencyBand: "RED",
  guidelineReference: "ACOG PB #222",
  ownerDisplay: "MFM service",
  dueDate: "2026-05-10",
});

console.log(JSON.stringify(task, null, 2));
```

Expected: `status: "requested"`, `intent: "proposal"`, `priority: "urgent"`.

## 11. Quick smoke test against the full prep flow

Confirm nothing regressed in the existing flow. Send the original prep prompt with Maria selected:

```
Full prep for tomorrow — cite guidelines for preeclampsia, GDM, aspirin, GBS, and corticosteroids.
```

You should still see all 5 grounding documents (NICE NG133, USPSTF, CDC GBS, IADPSG 2010, WHO 2022) cited in the brief, just as before. The new tools should not have broken anything.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `MaternalPanelScan` does not appear in `/health` tools list | `MATERNALGUARD_ENABLE_PANEL_SCAN` not set to exactly `true` | Check `.env`, restart the server |
| Panel scan returns "No bundled patients configured" | `MATERNALGUARD_BUNDLED_PATIENT_IDS` is empty and the fallback UUIDs do not match your workspace | Get the actual server-assigned UUIDs after the import, paste them into the env var, restart the server |
| Panel scan returns patients but all show empty signals | The Observation resources for each patient did not load (FHIR bundle import partially failed) | Re-import the cohort bundle, then check the patient detail page to confirm BP, AST, platelets are visible |
| Maria does NOT show `HELLP-evolution` pattern flag | The 4-signal pattern needs rising AST AND falling platelets AND (rising BP OR rising proteinuria). Confirm Maria has at least 2 chronological readings for each | Re-import Maria's bundle if any readings are missing |
| `ProposeMaternalAction` in live mode returns 401 or 403 | Workspace FHIR token does not have write permission | Check Prompt Opinion workspace settings; FHIR write access may need to be explicitly enabled |
| `ProposeMaternalAction` returns "createFlag=true requires both flagCategory and flagFinding" | The agent passed `createFlag: true` without the other two | Either send a more explicit prompt asking for the flag finding text, or set `createFlag: false` |

## What to do after the tests pass

1. Send the Darena team the follow-up note that includes the `fastmcp` UI question.
2. Demo the panel scan and write-back tools in your next Prompt Opinion sync.
3. Decide whether to migrate to Python `fastmcp` for prefab UI components, or wait for the TypeScript ADK to ship a UI layer.
4. Connect to Epic FHIR Sandbox for portability validation.
5. Generate a Synthea cohort and run a sensitivity / specificity study against the urgency classifier.
