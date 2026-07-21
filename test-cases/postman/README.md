# MaternalGuard FHIR Validation — Postman quickstart

A read-only Postman collection for validating that MaternalGuard's write-back path actually persists to the Prompt Opinion FHIR store, and for inspecting the ONC HTI-1 (b)(11) DSI transparency Provenance that every write emits.

## Setup (60 seconds)

1. Open Postman → **File > Import** → drop [MaternalGuard.postman_collection.json](MaternalGuard.postman_collection.json) in.
2. Click the imported collection root → **Variables** tab.
3. Fill in `bearerToken`. Fastest way to get it:
   - Open Prompt Opinion in your browser.
   - DevTools → **Network** tab → click any tool-call row.
   - Find the outbound POST to your MaternalGuard server (the URL contains `/mcp`).
   - Copy the value of the `X-FHIR-Access-Token` request header. That IS the workspace FHIR bearer.
   - Token rotates on session refresh — grab a new one when you see 401.
4. Confirm `workspaceId` and `patientId` match your environment. Defaults are Jonathan's Maria Santos setup.
5. Leave `taskId` / `flagId` empty for now — you'll fill them when you want to inspect a specific resource.

## Common workflows

### Prove a button click actually wrote to FHIR

1. In the MaternalGuard dashboard, click **Approve** on a draft task.
2. In your `npm start` terminal you'll see something like:
   ```
   [MCP] method=tools/call ... tool=UpdateMaternalAction argKeys=[action,taskId] token=YES(len=1330)
   ```
   That confirms the tool ran. To confirm the FHIR PUT persisted, keep going.
3. In Postman, run **2. Tasks → GET accepted Tasks**. The response bundle should contain the task you just approved with `Task.status === "accepted"`. That's the end-to-end proof.

Same shape for Reject, Activate, Dismiss:
- Reject → **GET rejected Tasks** should contain it with `Task.statusReason.text === "Rejected by clinician during huddle review"`.
- Activate → **GET active Flags** should contain the flag with `Flag.status === "active"`.
- Dismiss → **GET all Flags** with `status=entered-in-error` (edit the URL bar or duplicate the request) should contain it.

### Grab the DSI transparency Provenance for pre-demo b-roll

1. Copy a `taskId` from the server log (any recent tool-call line prints it in `argKeys`).
2. Paste into the collection's `taskId` variable.
3. Run **4. Provenance → GET Provenance targeting a Task**.
4. Verify the response bundle carries at least one Provenance whose:
   - `meta.profile[0]` equals `http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-Provenance`
   - `meta.security[0].code` equals `AIAST` (Artificial Intelligence Asserted, HL7 v3 ObservationValue)
   - `contained[0]` is an AI-Device with `aiKind = rule-based` and a `modelCardDescription` extension
   - `contained[1]` is an AI-ModelCard `DocumentReference` with a **CHAI Applied Model Card** content slice
   - `extension[0].url` equals `https://maternalguard.local/extensions/dsi-transparency/summary` with 13 (b)(11)(iv)(A) source-attribute sub-extensions filled in (interventionName, purpose, intendedPopulation, cautionedOutOfScopeUse, algorithmMethodology, underlyingKnowledgeSource, developer, fundingSource, releaseDate, version, biasAssessment, warningsLimitations, regulatoryFramework)

This is the exact wire shape MeldRx / Darena ship to certified customers. A 3-second cut of this JSON is a great trust-story b-roll for the Pawan Jindal / Magnus Wieslander reconnect demo video.

### Inspect duplicate draft Flags (historical or new)

MaternalGuard v2.0.1 added server-side dedup so back-to-back `ProposeMaternalAction` calls with the same finding will only write ONE Flag. Historical duplicates from earlier sessions are still on the chart though. To find them:

1. Run **3. Flags → GET draft Flags (status=inactive)**.
2. Group the response bundle's entries by `resource.code.text`. Any two entries with the same text are duplicates.
3. Cleanup: click **Dismiss** on the extras in the dashboard. The dedup logic ensures no fresh dupes get created going forward.

### Auth failed? (HTTP 401)

The bearer token rotated. Re-grab from DevTools:
- Prompt Opinion → DevTools → Network tab → click any MCP call → find `X-FHIR-Access-Token` header → copy value → paste into Postman `bearerToken` variable.

## What each folder is for

- **0. Local MaternalGuard health** — quick check that `npm start` is running. No auth.
- **1. Patient** — verifies your bearer token works and the patient resolves. Runs first to fail fast on auth errors.
- **2. Tasks** — every FHIR search filter you need to prove a Task write persisted (all / draft / accepted / rejected / by-id).
- **3. Flags** — same shape for Flag writes.
- **4. Provenance** — the trust-story b-roll. Includes a `_revinclude=Provenance:target` query for one-shot audit-trail verification (Task + its Provenance in one bundle).

## FHIR endpoint shape

The Prompt Opinion workspace FHIR API sits at:

```
{{baseUrl}}/api/workspaces/{{workspaceId}}/fhir/{ResourceType}[/{id}][?search]
```

Standard FHIR R4 REST semantics. The collection uses `Bearer` auth at the collection level; every request inherits it except the local `/health` check.
