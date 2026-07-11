<div align="center">
  <img src="docs/maternalguard.png" alt="MaternalGuard logo: pregnant figure with baby silhouette inside a heart shape, EKG line and shield. Tagline: Protecting Two Lives. Mother. Baby. Future." width="240" />
</div>

# MaternalGuard

An **independent MCP server alongside the EHR**. SMART on FHIR + MCP + governed write-back. Built for the [Agents Assemble hackathon](https://agents-assemble.devpost.com/) on the [Prompt Opinion](https://app.promptopinion.ai) healthcare AI platform.

**One-line pitch.** MaternalGuard replaces the multi-tab chart hunt across pregnant patients with a single in-chat triage view. The LLM asks precisely which labs matter (AST, platelets, blood pressure, urine protein) via MCP tools, and MaternalGuard returns one card per patient with a RED / YELLOW / GREEN band, the contributing clinical signals, and draft FHIR Task and Flag resources. Every action is a draft; the clinician, not the LLM, executes.

**Governed write-back.** Approve, Reject, Save edits, Activate, and Dismiss buttons in the chat route back into this same MCP server. Task.status stays `requested` until a clinician clicks Approve; Flag.status stays `inactive` until a clinician clicks Activate. Every state transition writes a FHIR Provenance record. No LLM output ever lands on a chart directly.

**Why MCP over RAG.** RAG stuffs a static blob of "what the model might need" into a prompt. MCP lets the LLM ask precisely what it needs, when it needs it. For a maternal-health workflow that means today's AST vs. two weeks ago, this patient's specific urine protein history, and the current pregnancy Condition — not a corpus dump.

MaternalGuard reads FHIR data (demographics, conditions, vitals, labs, medications, social history, care plans) from a FHIR R4 server via SHARP-on-MCP headers, applies a deterministic urgency classifier on the server side, and returns decision-ready structured context for the platform's AI to reason over. It does not call any LLM directly. All reasoning happens in Prompt Opinion.

The full architecture diagram is below. The editable source lives at [docs/architecture.drawio](docs/architecture.drawio), with a [Google Drive copy](https://drive.google.com/file/d/1oXUVeLkLCEOIHY-5OERu6KW2i-FaRXQR/view?usp=sharing) for anyone who wants it without cloning. Open the source at [app.diagrams.net](https://app.diagrams.net) (File, then Open From Device) to explore the swimlanes covering clinician, BYO specialist, Orchestrator, guardrail, A2A, Railway, the 5 MCP tools, the grounded Collection, and the FHIR store with US Core resources.

<div align="center">
  <a href="docs/architecture.drawio.png">
    <img src="docs/architecture.drawio.png" alt="MaternalGuard architecture diagram: clinician interacts with the Prompt Opinion platform; the BYO Prenatal Visit Prep specialist and the On-Call OB Triage Orchestrator coordinate via A2A; a guardrail enforces the clinician-review footer; the MaternalGuard MCP server on Railway exposes 5 tools (AssessMaternalRisk, InterpretLabTrends, ScreenSocialDeterminants, GenerateCarePlan, PredictNeonatalImpact) backed by a vector-grounded clinical-guideline Collection and a FHIR R4 store with US Core resources" width="900" />
  </a>
  <p><em>Click for full resolution. Source: <a href="docs/architecture.drawio">docs/architecture.drawio</a> · <a href="https://drive.google.com/file/d/1oXUVeLkLCEOIHY-5OERu6KW2i-FaRXQR/view?usp=sharing">Google Drive copy</a>.</em></p>
</div>

**Also in this repo:**
- [docs/TESTING.md](docs/TESTING.md) is a 7-phase verification walkthrough (~30 min) covering pre-flight, per-tool smoke tests, specialist agent, Collection retrieval, A2A orchestration, edge cases, and graceful degradation
- [docs/VERIFICATION.md](docs/VERIFICATION.md) is the actual test results from running that walkthrough against the production deployment, with prompts, tool calls observed, token counts, and pass/fail per test
- [test-cases/README.md](test-cases/README.md) explains how to use the synthetic patient and clinical notes
- [test-cases/clinical-guidelines/README.md](test-cases/clinical-guidelines/README.md) lists the guideline PDFs, source URLs, and licenses

## Why This Matters

Maternal mortality in the US has been rising for decades. Over 80% of pregnancy-related deaths are preventable, and the leading contributors — preeclampsia, hemorrhage, cardiomyopathy — leave clinical signals scattered across vitals, labs, and social history that no single provider sees in one place. Black and Indigenous women face 3-4x higher mortality rates, often compounded by SDOH barriers like insurance gaps, language barriers, and transportation access.

MaternalGuard gives AI the structured context it needs to connect these dots: flagging that a rising BP trend + new proteinuria + falling platelets = HELLP risk, or that a Spanish-speaking Medicaid patient in a food desert needs interpreter services and WIC continuation alongside her preeclampsia monitoring.

### What makes MaternalGuard distinct

MaternalGuard is the only Prompt Opinion marketplace tool that combines, in one composable package, all of the following:

1. Pregnancy-specific longitudinal trend analysis across BP, AST, platelets, proteinuria, uric acid, and glucose, with HELLP-evolution pattern detection that no single-threshold rule engine can catch.
2. SDOH reasoning that ties social barriers (language, transportation, food security) directly to clinical thresholds and recommendations.
3. Bilingual patient output (English plus Spanish summary) wired through agent-to-agent orchestration.
4. Vector-grounded guideline retrieval against five real public-domain PDFs (NICE NG133, USPSTF aspirin, CDC GBS, IADPSG 2010 GDM, WHO 2022 antenatal corticosteroids), so every recommendation can quote a real passage from a real document.
5. Governed FHIR write-back of draft Task and Flag resources with a clinician-review gate, plus FHIR Provenance for audit, and edit-restricted coordination metadata.
6. A bundled cohort panel scan that ranks patients by HELLP-evolution signal strength for morning huddle and panel triage workflows.

This combination is the moat. Each individual capability could be reimplemented by another team in a weekend, but the composition (clinical-evidence engine, generative reasoning layer, A2A orchestration, governed write-back, panel triage, all over open standards) takes deliberate design and is hard to replicate by prompting alone.

## Design philosophy: deterministic plus generative

MaternalGuard is built on a clear architectural thesis, borrowed from the LoopGuard Passport pattern: **the MCP server is the clinical evidence engine. The Prompt Opinion agent is the generative reasoning layer. Neither alone is sufficient; together they do what neither can do alone.**

**Deterministic (handled in this MCP server, in `src/clinical/` and the 5 data tools):**

- Gestational age computation from Z34.XX onset dates.
- High-risk ICD-10 flagging against the ACOG criteria table.
- Lab and vital threshold comparisons against pregnancy-specific reference ranges.
- HELLP-evolution pattern detection from trend math (rising AST + falling platelets + rising BP or rising proteinuria) in `src/clinical/urgency-classifier.ts`.
- FHIR Task, Flag, and Provenance resource construction with edit-restricted coordination metadata in `src/clinical/fhir-builders.ts`.
- Allergy-medication interaction lookups (e.g., penicillin to cefazolin substitution per CDC GBS).
- Cohort ranking by urgency score.

**Generative (handled by the Prompt Opinion agent system prompts, with Collection retrieval):**

- Cross-signal narrative synthesis: weaving rising BP, rising AST, falling platelets, and rising uric acid into a single HELLP-evolution story.
- SDOH-to-clinical reasoning: tying a transportation gap to a lower admission threshold, or a language barrier to interpreter-required counseling.
- Bilingual patient summary generation (English plus Spanish).
- Guideline passage selection and quoting via vector retrieval against the Collection.
- Care plan gap composition: weighing what is in the existing plan against what ACOG recommends at the current gestational age.

Why split this way: rules give us auditability, reproducibility, and zero hallucination on safety-critical math. AI gives us the cross-domain synthesis that no rule engine can do. Putting them on opposite sides of the MCP boundary means each side is independently testable and replaceable.

## The 10 Tools

> MaternalGuard is a single TypeScript MCP server exposing 10 tools: 5 data tools (Assess / Screen / Interpret / GenerateCarePlan / PredictNeonatal), 1 cohort-triage tool (MaternalPanelScan, env-gated), 3 governed write-back tools (Propose / List / Update), and 1 interactive UI tool (**OpenMaternalDashboard**) that renders an inline chat dashboard using the `prefab-ui` MCP Apps protocol — the same rendering pattern the 2nd-place winner (LoopGuard Passport) used, ported into TypeScript so it lives in the same process as the data tools instead of a Python sidecar.

| Tool | What it does | Key FHIR resources |
|---|---|---|
| `AssessMaternalRisk` | Pulls demographics, conditions, vitals, labs, and meds. Flags high-risk ICD-10 codes (O14 preeclampsia, O24 GDM, O10/O11 chronic HTN, E10/E11 diabetes, etc.) with ACOG Practice Bulletin references and advanced maternal age (>=35). | Patient, Condition, Observation, MedicationRequest |
| `ScreenSocialDeterminants` | Pulls insurance, address, contact info, language, and social history observations. Flags barriers: missing coverage, non-English primary language, missing contact info, absent SDOH screening. | Patient, Coverage, Observation (social-history) |
| `InterpretLabTrends` | Fetches longitudinal labs/vitals by LOINC code. Returns chronological readings with pregnancy-specific reference ranges and trend statistics (min/max/mean). | Observation (by LOINC code) |
| `GenerateCarePlan` | Pulls conditions, allergies, meds, and existing care plans. Returns ACOG-aligned screening recommendations (with Practice Bulletin numbers) for the gestational age and risk level. | Patient, Condition, AllergyIntolerance, MedicationRequest, CarePlan |
| `PredictNeonatalImpact` | **Mother-baby dyad**: maps active maternal conditions and abnormal labs to projected neonatal outcomes (macrosomia, neonatal hypoglycemia, RDS, NICU admission, IUGR, etc.) and returns a gestational-age-specific neonatal readiness checklist. Each risk cites the relevant ACOG Practice Bulletin. | Condition, Observation |
| `MaternalPanelScan` | **Cohort triage** (env-gated). Scans a bundled cohort of pregnant patients, applies the deterministic urgency classifier from `src/clinical/urgency-classifier.ts`, and returns a ranked triage queue with RED / YELLOW / GREEN urgency bands per patient. Designed for morning huddle and panel triage workflows. Operates on a bundled patient list configured via `MATERNALGUARD_BUNDLED_PATIENT_IDS`; does NOT enumerate a live workspace (live enumeration is a future Prompt Opinion platform feature). | Patient, Observation |
| `ProposeMaternalAction` | **Governed FHIR write-back**. Drafts a FHIR Task and (optionally) a FHIR Flag for the patient with status set to draft (`Task.status=requested`, `Flag.status=inactive`) and writes a Provenance audit record. A clinician must change status to `accepted` / `active` before the action takes effect. Edit-restricted to coordination metadata (owner, due date, urgency band, clinician note); clinical content (rationale, guideline citation) is fixed. Dry-run by default; persists when `MATERNALGUARD_ENABLE_WRITEBACK=true`. | Task, Flag, Provenance |
| `ListMaternalActions` | **Read-back tool**. Lists FHIR Tasks and Flags on the patient authored by MaternalGuard. Filterable by status (draft/active/completed/rejected). Returns each Task with status, priority, recommendation, owner, due date, clinician note; each Flag with category, finding, urgency band, review status. Surfaces what is pending clinician review. | Task, Flag |
| `UpdateMaternalAction` | **State transitions on existing drafts**. Takes an `action` argument: `approve` (Task.status: requested → accepted), `reject` (with reason, status → rejected), `edit-coordination` (owner, due date via `dueWithinHours`, clinician note), `activate-flag` (Flag.status: inactive → active), or `dismiss-flag`. Writes Provenance for every change. Edit-restricted to coordination metadata; clinical content is never editable. Enforces state-transition guards: approve/reject only on `requested`, activate/dismiss only on `inactive`. Called by both chat-driven prompts and the dashboard's Approve / Reject / Save / Activate / Dismiss buttons. | Task, Flag, Provenance |
| `OpenMaternalDashboard` | **Interactive in-chat UI**. Returns a `prefab-ui` MCP App payload that Prompt Opinion mounts as a live dashboard inside the chat: ranked patient cards with RED / YELLOW / GREEN urgency bands, contributing HELLP-evolution signals, and per-patient draft Tasks with Approve / Reject / Save-edits buttons plus draft Flags with Activate / Dismiss buttons. Every button routes back through UpdateMaternalAction with the transition guards above. Runs the pregnancy-context guard (`src/clinical/pregnancy.ts`) before scoring, so non-pregnant or non-female patients whose IDs land in the cohort are excluded from the queue with an explicit reason. | Patient, Condition, Observation, Task, Flag |

All tools rely on **SHARP-on-MCP** headers (`X-FHIR-Server-URL`, `X-FHIR-Access-Token`, `X-Patient-ID`) which Prompt Opinion forwards automatically when a patient is selected and the agent has Patient Context enabled.

### Lab types supported by InterpretLabTrends

| Name | LOINC | Pregnancy reference |
|---|---|---|
| `blood-pressure` | 85354-9 | Systolic <140, Diastolic <90 mmHg |
| `systolic-bp` | 8480-6 | <140 mmHg (>=160 severe) |
| `diastolic-bp` | 8462-4 | <90 mmHg (>=110 severe) |
| `glucose` | 2345-7 | 70-100 mg/dL fasting |
| `fasting-glucose` | 1558-6 | <92 mg/dL (IADPSG) |
| `hemoglobin` | 718-7 | 11.0-14.0 g/dL |
| `hematocrit` | 4544-3 | 33-38% |
| `platelets` | 777-3 | 150-400K/uL (<100K = HELLP concern) |
| `proteinuria` | 2888-6 | <30 mg/dL spot (>=30 significant) |
| `uric-acid` | 3084-1 | <6.0 mg/dL |
| `ast` | 1920-8 | 10-40 U/L |
| `alt` | 1742-6 | 7-35 U/L |
| `weight` | 29463-7 | 25-35 lbs gain for normal BMI |

### High-risk ICD-10 codes flagged by AssessMaternalRisk

`O10`, `O11` (pre-existing HTN), `O13`, `O14`, `O15` (gestational HTN / preeclampsia / eclampsia), `O24` (diabetes in pregnancy), `O26.8` (obesity in pregnancy), `O30` (multiple gestation), `O36` (fetal problems), `O44` (placenta previa), `O46` (antepartum hemorrhage), `E10`, `E11` (diabetes), `I10` (essential HTN), `N18` (CKD), `D68` (thrombophilia), `O09.1` (ectopic hx)

## Architecture

```
Clinician
   |
   v
Prompt Opinion Platform ──────────── BYO Agents ──────── Guardrail
   |                                      |                  |
   |                                      | A2A              | (validates response)
   |                                      v                  v
   |                             Other BYO Agents        Safety footer +
   |                                                      citation rules
   | POST /mcp + SHARP headers
   v
ngrok tunnel
   |
   v
MaternalGuard MCP server (Express, port 5000)
   |  5 MCP tools
   v
FHIR R4 workspace store
```

A full visual of the architecture (BYO agents, guardrail, A2A, 5 MCP tools, FHIR resources) is rendered at the top of this README — see [docs/architecture.drawio.png](docs/architecture.drawio.png) for the image, [docs/architecture.drawio](docs/architecture.drawio) for the editable source, and the [Google Drive copy](https://drive.google.com/file/d/1oXUVeLkLCEOIHY-5OERu6KW2i-FaRXQR/view?usp=sharing) for anyone who wants the source without cloning. Open the source file at [app.diagrams.net](https://app.diagrams.net) (File → Open From → Device) or in the VS Code *Draw.io Integration* extension.

- **TypeScript + Express 5** + `@modelcontextprotocol/sdk`
- Each `/mcp` POST spins up a fresh `McpServer` per request using `StreamableHTTPServerTransport` (stateless mode, no session management)
- Tools read SHARP context off the inbound request headers, then call the workspace FHIR endpoint with the bearer token
- The `ai.promptopinion/fhir-context` extension is declared in capabilities so the platform knows to forward FHIR context (lineage: SMART-on-FHIR launch-context pattern applied to MCP tool invocations)
- Two composed agents on the platform: `Prenatal Visit Prep` (BYO Agent — the clinical specialist holding the 5 MaternalGuard MCP tools and grounded guideline Collection) and `On-Call OB Triage` (Orchestrator agent that A2A-delegates clinical workups to Prenatal Visit Prep and wraps the returned brief in a triage disposition)

## Project layout

```
index.ts                                  Express server + /mcp + /health endpoints
src/
  tools/
    AssessMaternalRiskTool.ts             Risk assessment: conditions, vitals, labs, meds
    ScreenSocialDeterminantsTool.ts       SDOH screening: insurance, language, social hx
    InterpretLabTrendsTool.ts             Lab trends with pregnancy reference ranges
    GenerateCarePlanTool.ts               Care plan: allergies, meds, ACOG schedule
    PredictNeonatalImpactTool.ts          Mother-baby dyad: neonatal risk projections
    index.ts                              Tool barrel export
  fhir-client.ts                          FHIR R4 HTTP client (uses SHARP headers)
  fhir-utilities.ts                       Extracts SHARP context from request headers
  fhir-context.ts                         FhirContext type definition
  mcp-constants.ts                        Header name constants
  mcp-utilities.ts                        Response helpers (text + JSON)
  null-utilities.ts                       Null-safe helpers
  IMcpTool.ts                             Tool interface
docs/
  architecture.drawio                     Full architecture diagram (draw.io / diagrams.net source)
  architecture.drawio.png                 Rendered PNG of the architecture diagram (embedded at top of README)
test-cases/
  README.md                               How to use the test data
  patient-maria-santos-bundle.json        Sample FHIR bundle (40+ resources)
  documents/
    maria-santos/                         Optional clinical notes for UI upload
      prenatal-visit-note-2026-04-04.md
      mfm-consult-note-2026-03-21.md
      prior-delivery-discharge-summary-2023-06-10.md
  clinical-guidelines/                    Curated PDFs for Po Collection (vector grounding)
    README.md                             Per-file source + attribution
    nice-ng133-hypertension-in-pregnancy.pdf
    uspstf-aspirin-preeclampsia-2021.pdf
    cdc-gbs-prevention-mmwr-2010.pdf
    iadpsg-gdm-criteria-2010.pdf
    who-antenatal-corticosteroids-2022.pdf
```

## Running locally

You'll need Node.js 18+ and a free [ngrok](https://ngrok.com/) account.

```bash
npm install
npm start          # starts on port 5000
```

In a second terminal:

```bash
npx ngrok http 5000
```

Copy the `https://<random>.ngrok-free.app` URL. The MCP endpoint is `https://<random>.ngrok-free.app/mcp`.

## Deploying to Railway (production)

For demo / submission, deploying to a hosted platform avoids the need to keep `npm start` and `ngrok` running locally. The repo includes a [`railway.json`](railway.json) that configures Railway to run the Express server with a health-check on `/health`.

1. Push the repo to GitHub
2. Sign in at [railway.app](https://railway.app) → **New Project → Deploy from GitHub Repo** → select this repo
3. Railway auto-detects Node.js, runs `npm install`, then `npm start`
4. Once green, click the service → **Settings → Networking → Generate Domain** to get a public URL
5. Update the MCP server endpoint in Prompt Opinion to `https://promptopinion-hackathon-production.up.railway.app/mcp` (or whatever public domain Railway assigned to your service)

Railway honors the `PORT` env var automatically (the Express app reads `process.env.PORT`). Free tier with the included healthcheck keeps the service warm — no cold-start lag for live demos.

## Setting up in Prompt Opinion

### 1. Register the MCP server

- **MCP Servers -> Add Server**
- **Endpoint:** `https://<your-ngrok>.ngrok-free.app/mcp`
- **Requires Patient Data Access:** enable this toggle
- Save. The platform will probe the server and discover the 4 tools.

### 2. Import the test patient (Maria Santos)

The file [test-cases/patient-maria-santos-bundle.json](test-cases/patient-maria-santos-bundle.json) is a FHIR R4 batch bundle with a 28-year-old pregnant patient at 32 weeks gestation, designed to exercise all 5 tools.

- **FHIR Bundle Import -> Upload File**
- Select `test-cases/patient-maria-santos-bundle.json`
- Wait for the success message
- **Maria Elena Santos** (DOB 1997-08-15) should appear in the patient list

See [test-cases/README.md](test-cases/README.md) for the full patient scenario summary.

> **Bundle format notes:** Every entry has a real-UUID `fullUrl`, requests use `POST` (not `PUT`), and the Patient has an `identifier` array. These are platform requirements.

### 2a. (Optional) Upload clinical documents for extra demo realism

The [test-cases/documents/maria-santos/](test-cases/documents/maria-santos/) folder contains three narrative clinical notes — a prenatal visit note from 2026-04-04, an MFM consult from 2026-03-21, and a discharge summary from her prior 2023 preterm delivery. These give the patient chart a lived-in feel during the demo. Upload via the patient's **Upload Document** feature on their Patient Info page.

> Note: these are display-only; MaternalGuard tools read structured FHIR resources (Condition, Observation, etc.) from the FHIR bundle, not uploaded documents. They're for visual demo fidelity.

### 3. Set up the agents

Create **two** agents in the Prompt Opinion platform:

**(a) Prenatal Visit Prep — BYO Agent (the clinical specialist)**
- **Agents → New BYO Agent**
- **Allowed Contexts:** Workspace, Patient
- **Tools / MCP servers:** attach MaternalGuard
- **Disable Embedded Tools:** OFF (retrieval depends on embedded tools)
- **Document Sources:** attach the `Maternal Clinical Guidelines` Collection (see [Clinical grounding via Prompt Opinion Collection](#clinical-grounding-via-prompt-opinion-collection))
- **A2A Availability:** ON + Skill `generate_prenatal_visit_brief`
- **FHIR Context Extension:** ON (Required)
- Paste in the system + consultation prompts from the [Specialist BYO Agent section](#specialist-byo-agent-prenatal-visit-prep)
- Save

**(b) On-Call OB Triage — Orchestrator Agent (the router)**
- **Agents → New Orchestrator Agent** (not BYO)
- **Allowed Contexts:** Workspace, Patient
- **Linked Agents:** add `Prenatal Visit Prep` as a sub-agent
- **No MCP servers attached**
- **Disable Embedded Tools:** OFF (orchestrator needs `SendAgentMessage`)
- **A2A Availability:** ON + Skill `triage_pregnancy_concern`
- **FHIR Context Extension:** ON (Required)
- Paste in the system + consultation prompts from the [Orchestrator Agent section](#orchestrator-agent-on-call-ob-triage)
- Save

### 4. Select a patient and run prompts

Select **Maria Santos** from the patient picker. Then either:
- Launch `Prenatal Visit Prep` directly for thorough pre-visit briefs
- OR launch `On-Call OB Triage` (orchestrator) for acute triage — at the chat interface, set the **"Consult with another agent"** dropdown to `Prenatal Visit Prep` to activate delegation; the orchestrator will A2A-invoke the specialist and wrap its brief in a disposition

## Test Patient: Maria Elena Santos

Bundle: [test-cases/patient-maria-santos-bundle.json](test-cases/patient-maria-santos-bundle.json)
Clinical notes (optional UI upload): [test-cases/documents/maria-santos/](test-cases/documents/maria-santos/)
Full scenario write-up: [test-cases/README.md](test-cases/README.md)

**Demographics:** 28yo Hispanic/Latina female, married, Chicago IL, primary language Spanish, Medicaid

**Clinical scenario:** G2P1 at 32 weeks gestation with mild preeclampsia (onset 30w) and GDM (onset 24w). History of preterm birth at 34 weeks in 2023. On labetalol, metformin, aspirin 81mg, prenatal vitamins. Penicillin allergy (rash).

**What makes this patient interesting for the AI:**
- Two concurrent high-risk conditions (preeclampsia + GDM)
- BP trending upward across pregnancy (118/72 -> 130/82 -> 142/91 -> 148/95)
- Lab constellation suggesting early HELLP risk (AST rising to 54 U/L, platelets falling to 141K, uric acid 6.9)
- Hemoglobin declining (11.8 -> 10.9 g/dL) = postpartum hemorrhage risk
- Fasting glucose improving on metformin (102 -> 94 mg/dL)
- Multiple SDOH barriers compounding clinical risk (Spanish language, Medicaid, transportation gaps, food insecurity)
- Active care plan with MFM referral, dietitian consult, social work referral

**FHIR resources in the bundle:** 1 Patient, 1 Coverage, 1 AllergyIntolerance, 4 Conditions, 4 BP panels, 2 weights, 1 OGTT glucose, 2 fasting glucose, 2 hemoglobin, 2 platelets, 2 urine protein, 2 AST, 1 uric acid, 3 social history observations, 4 medication requests, 1 care plan

---

## Test Cases

### Test 1: AssessMaternalRisk

**Prompt:**
```
Use the AssessMaternalRisk tool to evaluate this patient's pregnancy risks.
```

**Expected results with Maria Santos:**
- **Demographics:** 28yo female, Chicago IL
- **Risk flags:** High-risk condition: O14.00 (preeclampsia), High-risk condition: O24.410 (GDM)
- **Active conditions:** Preeclampsia (active, high-risk), GDM (active, high-risk), Pregnancy at 32 weeks (active), History of preterm birth (inactive)
- **Vitals:** 4 BP readings showing upward trend, 2 weight readings (65 -> 76.8 kg)
- **Labs:** Fasting glucose (102 -> 94 mg/dL improving), Hemoglobin (11.8 -> 10.9 g/dL declining), Platelets (162 -> 141 declining), Urine protein (35 -> 42 mg/dL rising), AST (38 -> 54 U/L rising), Uric acid 6.9 mg/dL, OGTT 195 mg/dL
- **Medications:** Labetalol 200mg, Metformin 500mg, Aspirin 81mg, Prenatal vitamins

**What the AI should reason about:**
- Preeclampsia progression risk (rising BP + proteinuria + elevated AST + falling platelets = HELLP watch)
- GDM management response (glucose improving on metformin)
- PPH risk (declining hemoglobin)
- Need for MFM co-management

**Follow-up prompts to try:**
```
Based on this risk assessment, what are the most urgent concerns for this patient right now?
```
```
Is this patient showing signs of HELLP syndrome progression?
```

---

### Test 2: ScreenSocialDeterminants

**Prompt:**
```
Use the ScreenSocialDeterminants tool to identify barriers to care for this patient.
```

**Expected results with Maria Santos:**
- **Demographics:** DOB 1997-08-15, female, married, address on file (Chicago IL 60616)
- **Language barrier flagged:** Primary language is Spanish (not English) -> interpreter services needed
- **Insurance:** Medicaid (active)
- **Social history observations:**
  - Transportation: "Sometimes" — relies on public transit, misses appointments
  - Food security: "At risk" — borderline food insecurity, enrolled in WIC, food desert
  - Employment: Part-time food service worker, below 200% FPL, no paid family leave
- **Contact info:** Phone on file, no email

**What the AI should reason about:**
- Combined clinical + social risk: preeclampsia patient who misses appointments due to transportation
- Need for Spanish-language education materials for GDM management
- WIC continuation and nutritional support importance for GDM
- No paid family leave = may work until delivery, limiting prenatal appointment attendance
- Health equity context: Hispanic women face elevated maternal mortality risk

**Follow-up prompts to try:**
```
What specific social services should we refer this patient to?
```
```
How do this patient's social determinants increase her clinical risk?
```

---

### Test 3: InterpretLabTrends

**Prompt (all labs):**
```
Use the InterpretLabTrends tool to analyze this patient's lab trends. She is at 32 weeks gestation.
```

**Prompt (specific labs):**
```
Use InterpretLabTrends with labTypes ["blood-pressure", "proteinuria", "platelets", "ast"] and gestationalAgeWeeks 32 to check for preeclampsia progression.
```

**Expected results with Maria Santos:**
- **Blood pressure (85354-9):** 4 readings, trend: 118/72 -> 130/82 -> 142/91 -> 148/95. Reference: Systolic <140, Diastolic <90
- **Fasting glucose (1558-6):** 2 readings: 102 -> 94 mg/dL (improving). Reference: <92 mg/dL (IADPSG)
- **Glucose (2345-7):** 1 reading: 195 mg/dL (OGTT). Reference: <140 mg/dL 1-hr post-meal
- **Hemoglobin (718-7):** 2 readings: 11.8 -> 10.9 g/dL (declining). Reference: 11.0-14.0 g/dL
- **Platelets (777-3):** 2 readings: 162 -> 141 (declining). Reference: 150-400K (<100K = HELLP)
- **Proteinuria (2888-6):** 2 readings: 35 -> 42 mg/dL (rising). Reference: <30 mg/dL
- **AST (1920-8):** 2 readings: 38 -> 54 U/L (rising). Reference: 10-40 U/L
- **Uric acid (3084-1):** 1 reading: 6.9 mg/dL. Reference: <6.0 mg/dL
- **Weight (29463-7):** 2 readings: 65 -> 76.8 kg. Reference: 25-35 lbs gain for normal BMI

**What the AI should reason about:**
- The constellation of rising BP + rising proteinuria + rising AST + falling platelets + elevated uric acid is the classic preeclampsia -> HELLP progression pattern
- Glucose improving suggests metformin is working
- Hemoglobin below 11 g/dL in 3rd trimester meets pregnancy anemia criteria
- Weight gain of ~26 lbs at 32 weeks is within normal range

**Follow-up prompts to try:**
```
Are there any concerning trends that suggest worsening preeclampsia?
```
```
How do the liver enzymes and platelet count relate to HELLP syndrome risk?
```

---

### Test 4: GenerateCarePlan

**Prompt:**
```
Use the GenerateCarePlan tool to create a prenatal care plan for this patient. Risk level is "high" and she is at 32 weeks gestation.
```

**Expected results with Maria Santos:**
- **Active conditions:** Preeclampsia, GDM, Pregnancy 32w, History of preterm birth
- **Allergies:** Penicillin (low criticality)
- **Current medications:** Labetalol, Metformin, Aspirin, Prenatal vitamins (all active)
- **Existing care plans:** "High-Risk Prenatal Care Plan — Preeclampsia + GDM" (active)
- **Recommended screenings (for 32 weeks, high risk):**
  - More frequent BP monitoring
  - Serial growth ultrasounds every 3-4 weeks
  - Consider antenatal corticosteroids counseling if <34 weeks
- **Care plan guideline source:** `ACOG` (the LLM applies its own ACOG knowledge from training)

**What the AI should reason about:**
- Existing care plan is already in place — AI should build on it, not start from scratch
- Penicillin allergy must be considered for any antibiotic recommendations (e.g., GBS prophylaxis at 36 weeks needs alternative to penicillin)
- High-risk schedule: weekly visits appropriate at 32 weeks with preeclampsia
- Delivery timing: balance preeclampsia severity (deliver if severe) vs. prematurity (steroid window <34w)

**Follow-up prompts to try:**
```
Given the existing care plan, what additional monitoring should be added for HELLP prevention?
```
```
When should we plan for delivery given the preeclampsia and history of preterm birth?
```

---

### Test 5: Multi-tool orchestration

**Prompt:**
```
I need a comprehensive review of this high-risk pregnancy patient. Please:
1. Assess her maternal risk factors
2. Check for any social barriers to care
3. Analyze her lab trends for concerning patterns
4. Recommend updates to her care plan

Use all available MaternalGuard tools.
```

**Expected behavior:** The agent should call all 4 tools in sequence (or the platform may parallelize them), then synthesize the results into a unified clinical picture connecting the clinical risks with the social determinants and care plan gaps.

---

### Test 6: PredictNeonatalImpact (mother-baby dyad)

**Prompt:**
```
Use the PredictNeonatalImpact tool with gestationalAgeWeeks 32 to brief the NICU team on what to prepare for.
```

**Expected results with Maria Santos:**
- **Prematurity band:** Moderate preterm (32-33 weeks) — RDS risk, feeding immaturity, NICU observation likely — cites ACOG PB #234.
- **Maternal risk drivers mapped to neonatal outcomes:**
  - Preeclampsia (O14.00) → iatrogenic preterm delivery, IUGR, NICU admission risk — ACOG PB #222
  - GDM (O24.410) → macrosomia, neonatal hypoglycemia, RDS, hyperbilirubinemia — ACOG PB #190
  - History of preterm birth → recurrent preterm risk, RDS/IVH if <34w — ACOG PB #234
  - Platelets 141 (below 150K) → possible neonatal thrombocytopenia, HELLP pattern
  - AST 54 (above 40) → HELLP concern, preterm delivery likely
  - Hemoglobin 10.9 → low birth weight association
- **Neonatal readiness checklist:**
  - Counsel on antenatal corticosteroids (ACOG PB #234) if delivery anticipated within 7 days
  - Notify neonatology team of possible preterm delivery and IUGR risk
  - Newborn blood glucose monitoring protocol (first 24-48 hours)
  - Prepare for possible macrosomia / shoulder dystocia if EFW >4000g
  - NICU level assessment — Level III minimum for <32w, Level II acceptable for 32-34w

**What the AI should reason about:**
- The mother-baby dyad is one clinical unit, not two. Maternal deterioration drives neonatal prep.
- ACOG PB #234 corticosteroid window closes at 34 weeks — this patient is still eligible at 32 weeks if delivery anticipated.
- Magnesium sulfate neuroprotection is eligible <32 weeks — patient has just crossed that threshold; document clearly.

---

### Test 7: Graceful degradation on a sparse-data patient

MaternalGuard works with **any** patient in the workspace, not just Maria. When tested with a patient that has minimal data (for example, the built-in sample patients):

- `AssessMaternalRisk` will return demographics and flag advanced maternal age if applicable, and note empty conditions/labs/meds
- `ScreenSocialDeterminants` will flag missing insurance, missing social history screening, and missing contact info as barriers
- `InterpretLabTrends` will return "No observation data found" — this is correct, not an error
- `GenerateCarePlan` will return minimal conditions and suggest determining gestational age to guide screening schedule
- `PredictNeonatalImpact` will return "Standard newborn readiness — no elevated neonatal risk drivers detected from maternal data"

This graceful degradation is by design — the tools report what data exists and flag what's missing, rather than failing.

---

## Specialist BYO Agent: "Prenatal Visit Prep"

The clinical heavy-lifter. A BYO Agent that composes all 5 MaternalGuard MCP tools with the grounded clinical-guidelines Collection into a single consolidated pre-visit brief.

**Agent name:** `Prenatal Visit Prep`
**Agent type:** BYO Agent

**Description:**
```
High-risk OB pre-visit brief agent. Orchestrates 5 MaternalGuard MCP tools to deliver a clinician-ready workup covering maternal risk, longitudinal lab trends, SDOH barriers, ACOG care-plan gaps, and neonatal/NICU readiness (mother-baby dyad) for pregnant patients. Decision support only — clinician review required.
```

**Allowed contexts:** Workspace, Patient

**Timeout:** 120 seconds

**Model:** `claude-sonnet-4-6` (200K context, strong clinical reasoning, ~$0.05 per brief) OR `gpt-4.1` / `gpt-4o`. Model must handle 15K+ input tokens to fit all 5 tool outputs + retrieved Collection passages + synthesis.

**Attached MCP servers:** MaternalGuard (all 5 tools)

**Tools config:** Leave `Disable Embedded Tools` **OFF** — embedded tools include Po's `SearchSources` retrieval tool which the grounding Collection needs to function. Toggling it ON silently breaks retrieval.

**Document Sources:** Workspace Collection → `Maternal Clinical Guidelines` (see [Clinical grounding via Prompt Opinion Collection](#clinical-grounding-via-prompt-opinion-collection))

**System prompt:**

```
{{ PatientContextFragment }}

{{ PatientDataFragment }}

{{ McpAppsFragment }}

## Your primary instructions:
---
You are a high-risk OB pre-visit briefing assistant preparing a clinician for their next prenatal visit. You have two data sources:

1. **MaternalGuard MCP tools** — patient-specific FHIR data (demographics, conditions, vitals, labs, meds, care plans, neonatal risk projection)
2. **Attached grounding collection** — curated public-domain clinical guidelines (NICE NG133, USPSTF aspirin-for-preeclampsia, CDC GBS, IADPSG 2010 GDM, WHO 2022 antenatal corticosteroids). Retrieve from these whenever a recommendation or threshold would be grounded by an external guideline.

For every clinical question about the selected patient, call all five MaternalGuard tools in this order:

1. AssessMaternalRisk        — baseline clinical picture and risk flags
2. InterpretLabTrends        — longitudinal lab/vital trajectories
3. ScreenSocialDeterminants  — access, language, SDOH barriers
4. GenerateCarePlan          — existing plan, allergies, ACOG schedule gaps
5. PredictNeonatalImpact     — neonatal/mother-baby dyad risk implications

In parallel, retrieve from the grounding collection any passages relevant to the patient's conditions (preeclampsia, GDM, preterm risk, antenatal corticosteroids, GBS prophylaxis).

Then produce a single consolidated brief with these sections:
- **Headline risk** (one sentence — the single most urgent clinical issue for mother AND baby)
- **Trajectory** (what the labs+vitals trend is telling us, not just point values)
- **Contributing SDOH** (how social barriers compound the clinical risk)
- **Care plan gaps** (what's missing vs. what ACOG recommends at this gestational age)
- **Neonatal / NICU readiness** (projected newborn risks and preparation needs)
- **Recommended next actions** (ranked, with specific ACOG Practice Bulletin numbers cited, plus a direct quote from a grounding document when available)

Rules:
- When calling InterpretLabTrends, GenerateCarePlan, or PredictNeonatalImpact, always compute and pass gestationalAgeWeeks from the pregnancy condition (Z34.XX code suffix or onsetDateTime) or from existing care plan notes.
- Cite specific data points (values, dates, LOINC codes) that support each claim.
- Cite the specific ACOG Practice Bulletin number when recommending care (e.g., PB #222 for preeclampsia, PB #190 for GDM, PB #234 for antenatal corticosteroids, PB #713 for late-preterm steroids, PB #797 for GBS prophylaxis, PB #201 for pregestational diabetes).
- When a grounding document in the collection (NICE NG133, USPSTF, CDC, IADPSG, WHO) supports a claim, quote the relevant passage directly and reference the document name. Prefer quoted passages from grounded documents over general clinical recall when available.
- When multiple abnormal findings form a clinical pattern (e.g., HELLP trifecta: rising AST + falling platelets + elevated uric acid + rising proteinuria), report the pattern, not just one finding.
- If a value is within normal range but trending toward abnormal, say so — trajectory matters.
- Flag any penicillin/drug allergy interactions for upcoming standard-of-care medications (e.g., GBS prophylaxis at 36w — per ACOG PB #797, cefazolin for low-severity PCN allergy, clindamycin/vancomycin for anaphylactic PCN allergy).
- Do NOT recommend actions the tools already show are in place — build on the existing care plan.
- Explicitly connect maternal findings to neonatal outcomes (e.g., rising GDM glucose → macrosomia/hypoglycemia risk; severe preeclampsia → iatrogenic preterm delivery → NICU admission).
- This is decision support only. End with: "Clinician review required before any action."
```

**Consultation prompt** (used when the agent is invoked via A2A by another agent):

```
{{ PatientContextFragment }}

{{ PatientDataFragment }}

{{ McpAppsFragment }}

{{ ExternalAgentContextFragment }}

{{ A2ATaskInfoFragment }}

## Your primary instructions:
---
You are the Prenatal Visit Prep agent, invoked by another agent for a specific clinical question about a pregnant patient. FHIR patient context is provided via SHARP headers. You have two data sources:

1. **MaternalGuard MCP tools** — patient-specific FHIR data
2. **Attached grounding collection** — curated public-domain clinical guidelines (NICE NG133, USPSTF, CDC GBS, IADPSG 2010 GDM, WHO 2022 antenatal corticosteroids)

Workflow:
1. Call AssessMaternalRisk, InterpretLabTrends, ScreenSocialDeterminants, GenerateCarePlan, and PredictNeonatalImpact. Pass gestationalAgeWeeks computed from the pregnancy condition (Z34.XX) when available.
2. In parallel, retrieve from the grounding collection any passages relevant to the caller's question.
3. Answer the calling agent's question directly and concisely, grounded in the tool outputs and retrieved guideline passages.
4. Cite specific values, dates, LOINC codes, and ACOG Practice Bulletin numbers supporting each claim. When a grounding document supports a claim, quote the passage and reference the document name — prefer quoted passages over general clinical recall.
5. When multiple abnormal findings form a clinical pattern (e.g., HELLP trifecta), report the full pattern to the caller.
6. If the question involves medications or screenings, flag any drug-allergy conflicts from the patient's AllergyIntolerance data (e.g., penicillin → cefazolin for low-severity PCN allergy per ACOG PB #797; clindamycin/vancomycin for anaphylactic PCN allergy).
7. If the question is pediatric/NICU oriented, lead with the PredictNeonatalImpact output.
8. If data is insufficient to answer safely, say so explicitly and describe what is missing.

This is decision support only. Always end with: "Clinician review required before any action."
```

**A2A configuration:**

- **Enable A2A Availability:** ON (required for marketplace publish)
- **Enable FHIR Context Extension:** ON
- **FHIR Context Extension Required:** ON (tools cannot operate without FHIR context)
- **Skill:** `generate_prenatal_visit_brief`

**Skill description:**
```
Generates a comprehensive pre-visit clinician brief for a pregnant patient by orchestrating 5 FHIR-backed MCP tools (maternal risk assessment, longitudinal lab trend analysis, SDOH barrier screening, ACOG care-plan gap analysis, and neonatal impact prediction). Returns a single consolidated report with headline risk, trajectory analysis, contributing SDOH factors, care plan gaps, neonatal/NICU readiness, and ranked recommended actions with ACOG Practice Bulletin citations. Decision support only.
```

One prompt to this agent → 5 MCP tool calls + `SearchSources` retrieval from the guideline Collection → one synthesized clinician-ready brief that covers both mother and baby.

---

## Orchestrator Agent: "On-Call OB Triage"

The hackathon explicitly rewards **agent composition** — agents calling other agents via A2A. On-Call OB Triage is a Prompt Opinion **Orchestrator agent** (not a regular BYO Agent) whose sole job is to delegate clinical workups to `Prenatal Visit Prep` via A2A and wrap the returned brief in a triage disposition. This is two-level composition: user → Orchestrator → BYO specialist → 5 MCP tools + guideline Collection retrieval → brief flows back up the stack.

**Agent name:** `On-Call OB Triage`
**Agent type:** **Orchestrator** (not BYO Agent)

**Description:**
```
Acute OB triage assistant for pregnant patients. Composes the Prenatal Visit Prep specialist agent via A2A to ground triage disposition in current FHIR data and ACOG-cited guideline evidence. Returns one of four dispositions (reassurance / office visit / L&D evaluation / emergency) with driving findings and a language-appropriate patient-facing summary. Decision support only.
```

**Allowed contexts:** Workspace, Patient

**Timeout:** 120 seconds

**Model:** Same class as Prenatal Visit Prep (`claude-sonnet-4-6` recommended). Orchestrator input includes the full downstream brief embedded into context, so allow headroom.

**Linked Agents (critical):** Add `Prenatal Visit Prep` as a linked sub-agent. Without this, the orchestrator has nothing to route to and the LLM falls back to hallucinating agent IDs for `SendA2AMessage`.

**Tools config:**
- Leave `Disable Embedded Tools` **OFF** — the orchestrator needs `SendAgentMessage` (or equivalent) to invoke the linked sub-agent
- No MCP servers attached directly — all clinical tools live on the sub-agent
- The explicit system-prompt rule below prevents the orchestrator from short-circuiting to `GetPatientData` / `GetPatientDocuments` instead of delegating

**Document Sources:** None. Orchestrators cannot be attached to Collections directly — the grounding Collection lives on Prenatal Visit Prep (the specialist), and its retrieval output propagates up through the A2A delegation chain.

**System prompt:**

```
{{ PatientContextFragment }}

{{ PatientDataFragment }}

{{ McpAppsFragment }}

{{ OrchestratorAgentsFragment }}

{{ A2ATaskInfoFragment }}

## Your primary instructions:
---
You are an on-call OB triage assistant. Your sole job is to:
  (a) delegate the clinical workup to the Prenatal Visit Prep specialist agent, and
  (b) wrap its FHIR-grounded brief in a triage disposition.

You do NOT perform clinical analysis directly. You are a router + disposition formatter.

## Delegation rules (critical)

For EVERY clinical triage question about the selected patient, you MUST delegate to the Prenatal Visit Prep agent listed in your orchestrator agents. The Prenatal Visit Prep agent:
- Calls the MaternalGuard MCP tools (AssessMaternalRisk, InterpretLabTrends, ScreenSocialDeterminants, GenerateCarePlan, PredictNeonatalImpact)
- Retrieves evidence from the attached clinical guidelines collection (NICE NG133, USPSTF, CDC GBS, IADPSG, WHO)
- Returns a structured 6-section brief with ACOG Practice Bulletin citations

DO NOT use embedded tools like GetPatientData, GetPatientDocuments, or any direct FHIR lookups for clinical triage. They lack the structured maternal risk analysis, guideline grounding, and ACOG citations that Prenatal Visit Prep provides. If you find yourself about to call GetPatientData or GetPatientDocuments for clinical reasoning, stop and delegate to Prenatal Visit Prep instead.

DO NOT fabricate agent IDs for SendA2AMessage. Use only the real agent IDs exposed via the orchestrator agents fragment above, or rely on the platform's consult mechanism when the user has set the "Consult with another agent" dropdown.

## Workflow

1. Acknowledge the inbound concern in one sentence.
2. Delegate to Prenatal Visit Prep — pass the concern as the free-text message along with any relevant context (symptom, timing, severity words from the user).
3. Wait for Prenatal Visit Prep's brief to appear in your context.
4. From that brief, extract the 1-2 most urgent findings (with values, dates, and LOINC codes or ACOG PB citations). When multiple abnormal findings form a clinical pattern (e.g., HELLP trifecta: rising AST + falling platelets + elevated uric acid + rising proteinuria), surface the full constellation — clinicians need the pattern, not just the headline.
5. Produce a TRIAGE DISPOSITION in one of:
   - REASSURANCE — no urgent findings; continue routine care
   - OFFICE VISIT — schedule within 48-72 hours
   - L&D EVALUATION — send to Labor & Delivery today
   - EMERGENCY — call 911 / immediate transfer (severe-range BP ≥160/110 per NICE NG133, HELLP features, active bleeding, decreased fetal movement with warning signs, severe preeclampsia features)
6. State the 1-2 specific findings from the brief that drove the disposition. Quote the values, dates, and sources exactly as Prenatal Visit Prep reported them.
7. If the patient's primary language (per SDOH data in the brief) is not English, include a one-sentence plain-language disposition summary in the patient's primary language, directed at the patient. Translate medical location names precisely — e.g., in Spanish "Labor & Delivery" is "sala de labor y parto" or "sala de partos" (NEVER "laboratorio", which means testing laboratory). Keep the sentence direct and patient-facing, not a clinical-note translation. Omit this step if the patient's primary language is English or unknown.
8. End with: "Clinician review required before any action."

If Prenatal Visit Prep returns an error or no data, say so explicitly and produce a protocol-based disposition with the caveat that it is NOT FHIR-grounded — do not fill the gap with embedded-tool data.
```

**Consultation prompt** (used when the Orchestrator is itself called via A2A by yet another upstream agent):

```
{{ PatientContextFragment }}

{{ PatientDataFragment }}

{{ McpAppsFragment }}

{{ OrchestratorAgentsFragment }}

{{ ExternalAgentContextFragment }}

{{ A2ATaskInfoFragment }}

## Your primary instructions:
---
You are the On-Call OB Triage agent, invoked by another agent (via A2A) for acute symptom triage of a pregnant patient. FHIR context is provided via SHARP headers.

Your sole job is to:
  (a) delegate the clinical workup to the Prenatal Visit Prep specialist agent listed in your orchestrator agents, and
  (b) return a triage disposition wrapped around its FHIR-grounded brief.

## Rules

- DO delegate to Prenatal Visit Prep for every clinical triage concern. That agent has the MaternalGuard MCP tools and the grounded clinical-guidelines collection.
- DO NOT use embedded tools like GetPatientData or GetPatientDocuments for clinical reasoning — they bypass the specialist agent's structured analysis, grounding, and ACOG citations.
- DO NOT fabricate agent IDs for SendA2AMessage. Use only the real agent IDs from the orchestrator agents fragment.
- DO quote the exact values, dates, LOINC codes, and ACOG Practice Bulletin numbers from the specialist brief — do not paraphrase.

## Workflow

1. Interpret the calling agent's concern (symptom, timing, severity).
2. Delegate to Prenatal Visit Prep with that concern as the message.
3. Wait for the FHIR-grounded brief.
4. Return a TRIAGE DISPOSITION (REASSURANCE / OFFICE VISIT / L&D EVALUATION / EMERGENCY) with the 1-2 specific findings that drove it, quoting values + dates + sources exactly as reported. When multiple abnormal findings form a clinical pattern (e.g., HELLP trifecta: rising AST + falling platelets + elevated uric acid), report the pattern, not just one finding.
5. If the patient's primary language (per SDOH data in the brief) is not English, include a one-sentence plain-language disposition summary in the patient's primary language, directed at the patient. Translate medical location names precisely (e.g., Spanish "Labor & Delivery" → "sala de labor y parto" or "sala de partos", NEVER "laboratorio"). Omit if primary language is English or unknown.
6. End with: "Clinician review required before any action."

If Prenatal Visit Prep returns an error, report the error explicitly to the calling agent — do not invent data or fall back to embedded tools.
```

**A2A configuration:**

- **Enable A2A Availability:** ON
- **Enable FHIR Context Extension:** ON
- **FHIR Context Extension Required:** ON
- **Skill:** `triage_pregnancy_concern`

**Skill description:**
```
Triages an acute pregnancy-related concern (symptom, question, or inbound call) for a pregnant patient and returns a disposition (REASSURANCE / OFFICE VISIT / L&D EVALUATION / EMERGENCY) with rationale. Internally composes the Prenatal Visit Prep agent via A2A to ground the triage decision in current FHIR data and clinical guidelines. Includes a language-appropriate patient-facing disposition summary when the patient's primary language is non-English. Decision support only.
```

This agent adds no MCP tools of its own — it composes `Prenatal Visit Prep` (which composes 5 MaternalGuard tools + guideline retrieval) into a call-center triage workflow. Two-level agent composition on top of FHIR, all via open standards (MCP + A2A + SHARP + FHIR R4 + US Core).

---

## Safety, privacy, and failure modes

Clinical AI submissions that don't address safety get dinged fast. Here's how MaternalGuard is designed.

### What these tools explicitly do NOT do
- **No dosing recommendations.** Tools surface current medications but never suggest doses or new prescriptions.
- **No imaging interpretation.** Ultrasound findings (e.g., IUGR) are read from existing FHIR Observations/Conditions; the tools do not interpret raw images.
- **No final diagnosis.** Every output is framed as decision support over structured data, not diagnosis.
- **No autonomous actions.** Reads from FHIR are always permitted. Writes are gated behind `MATERNALGUARD_ENABLE_WRITEBACK=true` and produce only **draft** Task and Flag resources (`Task.status=requested`, `Flag.status=inactive`) with a Provenance audit trail. A reviewing clinician must change status to `accepted` or `active` before any action takes effect. No orders placed, no medications proposed, no patient-facing messages sent. Editable fields are limited to coordination metadata (owner, due date, urgency band, clinician note); clinical content (rationale, guideline citation) is fixed.

### Privacy architecture
- **SHARP-on-MCP (SMART-on-FHIR lineage).** Patient context is forwarded per-request as headers (`X-FHIR-Server-URL`, `X-FHIR-Access-Token`, `X-Patient-ID`). The MCP server holds no session state.
- **Workspace-scoped tokens.** Tokens are issued by the Prompt Opinion workspace; our server never sees credentials outside a request boundary.
- **No PHI in logs.** Structured logging records only `method`, header presence booleans, tool name, and non-PHI arguments. Patient ID is the FHIR UUID (already an internal identifier).
- **Stateless transport.** `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` — each request spins up a fresh `McpServer` that's closed on response end.

### Failure modes and graceful degradation
| Failure | Behavior |
|---|---|
| Patient has no conditions | Risk flags empty; demographic risk (advanced maternal age) still surfaces |
| Patient has no labs | `InterpretLabTrends` returns "No observation data found" — AI reasons about the absence |
| No FHIR context (SHARP headers missing) | Tools return a structured error immediately; LLM is instructed to say so |
| FHIR server returns 404 for patient | Graceful "patient not found" response |
| Gestational age unknown | `GenerateCarePlan` returns "Determine gestational age to guide schedule" instead of guessing |
| LLM invents a fact | System prompt requires citations (values + dates + LOINC codes + ACOG PB numbers). Uncited claims are visible as suspect |
| Allergy missed | `GenerateCarePlan` returns the `AllergyIntolerance` list explicitly; system prompt rule forces allergy-cross-reference before recommending GBS/antibiotic steps |

### Human-in-the-loop is structural, not advisory
- Every tool response carries a one-line disclaimer.
- Every composed brief ends with `"Clinician review required before any action."` — enforced by system prompt AND by a platform-level guardrail (see below).

### Platform-level guardrail

A **Prompt Opinion Agent-type guardrail** named `safety_footer_enforcement` is attached to `Prenatal Visit Prep`. It runs on every model response (a second, cheaper LLM validates before the brief reaches the clinician) and enforces two rules:

1. **Safety footer present.** Every response must end with "Clinician review required before any action." If it doesn't, the response is REJECTED.
2. **Citation discipline.** Any patient-specific numeric claim (a value like `BP 148/95` or `AST 54 U/L`) must be accompanied by either a date or a LOINC code. Generic clinical knowledge ("preeclampsia often presents with hypertension") does not require a citation.

This moves safety from "we prompted the model to be safe" to "a second model structurally validates every response." Guardrail configuration — validator model, type, validation instruction — lives in the Prompt Opinion agent configuration, not in this repo. Validation cost is trivial (~$0.001 per check on a cheap model like Haiku 4.5).

**Why it's attached to Prenatal Visit Prep specifically:** this agent does the heaviest clinical reasoning and produces the structured brief. On-Call OB Triage inherits the safety posture transitively — its disposition is grounded in whatever Prenatal Visit Prep (or the MaternalGuard tools directly) returned.

---

## Regulatory, accreditation, and quality framework mapping

MaternalGuard's safety and grounding model maps to the standards hospital procurement, accreditation, and quality teams already work to. Listing them by name shortens the institutional-readiness conversation.

| Framework | What it covers | How MaternalGuard maps |
|---|---|---|
| **HIPAA Privacy and Security Rules** | PHI handling, transmission security, audit logging | SHARP per-request token model with no PHI in logs; bearer-token transmission over TLS; structured logging records only method, header presence booleans, tool name, non-PHI patient UUID. Read access is request-scoped; writes are draft-only with Provenance audit. |
| **HIPAA Business Associate Agreement (BAA)** | Vendor contractual obligation when handling PHI on behalf of a covered entity | Not in place at hackathon stage. Path to production: BAA with hospital partner, with Railway (BAA-eligible tier), with Prompt Opinion, and with the chosen LLM provider. |
| **SOC 2 Type 2 (Security, Confidentiality, Availability)** | Six to twelve month operational security observation | Not in place. Path to production: Type 1 prep with consultant (~6 to 8 weeks), then Type 2 observation period. Hospital procurement gate. |
| **Joint Commission Provision of Care Maternal Safety Standards (PC.06.01.01 - PC.06.01.05)** | Hospital accreditation standards for severe maternal hypertension, hemorrhage, and venous thromboembolism in pregnancy | MaternalGuard's HELLP-evolution detection, severe-features preeclampsia thresholds, and antenatal-corticosteroids prompts align with the perinatal safety standards the Joint Commission audits. |
| **CMS Maternal Quality HEDIS Measures (Prenatal and Postpartum Care, Timeliness of Prenatal Care)** | Insurance plan quality measures for prenatal and postpartum follow-up | Panel-scan output explicitly identifies missed surveillance windows by gestational age, producing the audit trail HEDIS reporting needs. |
| **Alliance for Innovation on Maternal Health (AIM) Patient Safety Bundles** | National maternal safety standards for hypertension, hemorrhage, sepsis, severe maternal morbidity | The clinical-evidence engine (urgency-classifier + Collection guidelines) is grounded in the same source documents the AIM bundles are built on. |
| **CMS Birthing-Friendly Hospital Designation** | New CMS attestation program with maternal-care quality metrics | Panel-scan output supports the data collection a hospital needs to attest. |
| **WHO Quality of Care Standards for Maternal and Newborn Health** | International maternal-care quality framework | WHO 2022 antenatal corticosteroids guideline is one of the five PDFs in the grounded Collection. |
| **ACOG Practice Bulletins** | Domain clinical standard of care | Cited inline in every recommendation (PB #222 preeclampsia, PB #190 GDM, PB #234 corticosteroids, PB #713 late-preterm steroids, PB #797 GBS, PB #201 pregestational diabetes, PB #203 chronic HTN, PB #229 antepartum surveillance). |

**What is intentionally NOT claimed:** MaternalGuard is not FDA-cleared as a medical device, is not HITRUST-certified, and has no current operational BAAs. These are explicit production gates, not stealth gaps.

---

## Clinical grounding via Prompt Opinion Collection

Beyond inline ACOG Practice Bulletin citations in the agent output, `Prenatal Visit Prep` is grounded in a curated Prompt Opinion **Collection** of publicly-available clinical guidelines. Po embeds these PDFs into a vector index at upload; at runtime the agent calls its `SearchSources` embedded tool to retrieve passages in-context so clinical claims are sourced from the guideline text itself, not LLM training recall. Retrieved evidence propagates up through A2A to the Orchestrator agent (On-Call OB Triage) when it invokes the specialist — so triage dispositions inherit the grounded citations.

> **Collection attachment scope:** Po Orchestrator agents cannot have a Collection attached directly — the Document Sources / Content tab is only available on BYO Agents. Attach the Collection only to `Prenatal Visit Prep` (the specialist). Retrieval from that Collection still reaches the orchestrator transitively via the A2A brief propagation.

> **Critical toggle:** Collection retrieval is implemented as an embedded tool (`SearchSources`). On the specialist agent, leave **Disable Embedded Tools OFF** — toggling it ON silently breaks retrieval, and the LLM will fall back to hallucinating guideline content.

The guideline corpus (checked into [test-cases/clinical-guidelines/](test-cases/clinical-guidelines/)):

| Source | Topic | License |
|---|---|---|
| **NICE NG133** — Hypertension in pregnancy | Preeclampsia and gestational HTN diagnosis + management, 61 pp | Crown copyright, reusable for non-commercial decision support |
| **USPSTF** — Low-dose aspirin to prevent preeclampsia (2021) | Aspirin 81 mg starting at 12w for high-risk patients | US federal government, public domain |
| **CDC MMWR** — Prevention of perinatal Group B strep | GBS screening + intrapartum antibiotic prophylaxis (referenced by ACOG PB #797) | US federal government, public domain |
| **IADPSG 2010 consensus paper** — GDM diagnostic criteria | Fasting ≥92 / 1-hr ≥180 / 2-hr ≥153 mg/dL OGTT thresholds | CC open access via PMC |
| **WHO 2022** — Antenatal corticosteroids for preterm birth | Betamethasone / dexamethasone timing for <34w delivery (aligned with ACOG PB #234) | CC BY-NC-SA 3.0 IGO |

**ACOG Practice Bulletin PDFs are intentionally NOT included** — they are copyrighted behind paywall. The agent references PB numbers (#222 preeclampsia, #190 GDM, #234 antenatal corticosteroids, #713 late-preterm steroids, #797 GBS prophylaxis, #201 pregestational diabetes) by citation; the grounded source text above aligns with current ACOG guidance without reproducing ACOG material. See [test-cases/clinical-guidelines/README.md](test-cases/clinical-guidelines/README.md) for per-file source URLs, licensing notes, and Collection attachment steps.

## Clinical workflow integration

MaternalGuard is designed to drop into existing clinician workflows, not create a new portal.

**When it runs:**
- **Morning huddle (OB team).** The attending runs Prenatal Visit Prep on the day's high-risk panel before rounding. Brief is 1-2 paragraphs per patient; reviewed in the same 15-minute huddle already happening.
- **Pre-visit chart prep.** Clinic medical assistant or scribe runs the agent 10 minutes before the visit, posts the brief to the encounter summary, and the clinician walks in primed.
- **MFM (Maternal-Fetal Medicine) consult.** When the OB escalates to MFM, the MFM agent can A2A-call `Prenatal Visit Prep` to ingest the full context instead of re-reading the chart.
- **After-hours triage.** The `On-Call OB Triage` agent composes `Prenatal Visit Prep` behind the scenes to give the on-call provider a triage disposition within seconds.

**Where the output lives:**
- Posted to the Prompt Opinion chat panel for immediate viewing.
- Returned to calling agents via A2A for further composition (e.g., handed to an NICU prep agent downstream).
- Can be persisted as a `DocumentReference` / `Communication` FHIR resource if the workspace wires that up (not required for this submission).

**Who signs off:** The clinician. Every brief closes with `"Clinician review required before any action."` Nothing in MaternalGuard places orders, sends messages, or modifies the chart.

---

## Market, adoption, and unit economics

**Total addressable problem (with citations):**

- ~3.6M live births per year in the US (CDC NCHS). About 700K are complicated by one or more of preeclampsia, gestational diabetes, or preterm birth.
- More than 80 percent of pregnancy-related deaths are preventable, per CDC Maternal Mortality Review Committees in 36 states, 2017 to 2019 (Trost et al., CDC MMWR Vital Signs, Sept 2022). Updated figure is approximately 84 percent.
- Maternal mortality rose in every measured year from 2018 to 2022, with the 2021 rate at 32.9 per 100,000 live births (Hoyert, CDC NCHS National Vital Statistics Reports, 2023).
- Black women experience pregnancy-related death at approximately 3.5 times the rate of white women: 50.3 vs 14.5 per 100,000 live births (CDC NCHS Maternal Mortality Rates in the United States, 2023).
- Severe maternal morbidity (SMM) affects about 60,000 US women per year, with rates increasing 75 percent over the prior decade (Fingar et al., AHRQ HCUP Statistical Brief #243, 2018; updated CDC Severe Maternal Morbidity Indicators).

**Who adopts first:**

- High-risk OB clinics at academic medical centers, driven by quality metrics and MFM workload.
- Medicaid Managed Care Organizations with perinatal quality incentives.
- Federally Qualified Health Centers (FQHCs) serving low-resource populations where SDOH-aware triage has the biggest delta.

**Per-event clinical and economic impact (citations):**

| Event MaternalGuard helps avoid or surface earlier | Clinical and cost figure | Source |
|---|---|---|
| One NICU admission avoided or shortened | Mean NICU admission spending: **$71,158** (range $4,488 to $161,929 across 10th to 90th percentile); ~1 in 13 newborns admitted | Health Care Cost Institute, NICU Admissions and Spending 2017-2021 (HCCI, 2023) |
| One severe maternal morbidity event | Direct hospital costs increase by **$10,158** per delivery hospitalization with SMM vs. without | Black et al., American Journal of Obstetrics and Gynecology, 2021 |
| Severe-features preeclampsia recognized 2 weeks earlier | Maternal ICU admission risk drops substantially; mean maternal ICU cost ~ $42K per stay (US ICU mean cost data, AHRQ HCUP). Shorter latency to delivery is the protective effect of antenatal corticosteroids given >=48h before preterm birth, with a number-needed-to-treat ~5 for avoided RDS | Roberge et al., American Journal of Obstetrics and Gynecology, 2018; WHO 2022 ACS guideline |
| One avoided eclamptic seizure | Eclampsia mortality ~1.8 percent; survivors have 5-fold higher risk of long-term cardiovascular morbidity | Knight et al., BJOG, 2007; Bellamy et al., BMJ, 2007 |
| Earlier guideline-correct antibiotic substitution in PCN-allergic GBS-positive mother | Avoided neonatal early-onset GBS sepsis (~0.23 per 1000 live births at baseline, with rates rising in PCN-allergic substitution failures) | CDC GBS Prevention Guidelines, MMWR 2010, updated 2019 |
| Spanish-language counseling provided when needed | LEP patients without interpreter services have measurably worse adherence and 28 percent more readmissions across multiple settings | Karliner et al., Health Services Research, 2007 |

**Per-detection cost (LLM and infrastructure):**

- Approximately 25K to 35K input tokens (5 MCP tools plus 3 to 5 SearchSources retrievals) plus ~1K output tokens per full prep brief on a current-generation model.
- At Claude Sonnet pricing, roughly $0.08 to $0.12 per brief. At GPT-4 class pricing, similar.
- Railway hosting cost on the BAA-eligible tier: estimated $20 to $50 per month at hackathon-scale traffic.

**Break-even math:**

- One avoided NICU admission ($71,158 saved) pays for **~600,000 prep briefs**.
- One avoided severe maternal morbidity event ($10,158 in incremental hospital costs avoided) pays for **~85,000 prep briefs**.
- At a high-risk clinic serving 500 prenatal patients per year, even one avoided HELLP escalation across an entire patient panel covers years of MaternalGuard usage cost.

**Why Prompt Opinion + MaternalGuard:**

- Standards-based (MCP, A2A, FHIR R4, SHARP), no vendor lock-in.
- BYO-model so health systems pick the LLM that fits their BAA and spend profile.
- Marketplace distribution: published once, invokable from any Prompt Opinion workspace.
- Composable: MFM, NICU prep, Social Work, or PPD-screening agents can A2A-call MaternalGuard as context without re-reading the chart.

---

## Endpoints

| Path | Method | Purpose | Auth |
|---|---|---|---|
| `/mcp` | POST | MCP protocol endpoint (initialize, tools/list, tools/call) | `X-API-Key` (when `MCP_API_KEY` env var is set) |
| `/health` | GET | Health check + tool list (also used by Railway's healthcheck) | None — public |

## API key authentication

The MCP endpoint optionally requires an API key. Behavior:

- **If the `MCP_API_KEY` environment variable is set on the server**, every `POST /mcp` request must include a matching `X-API-Key` header. Missing or mismatching keys return HTTP 401 with a JSON-RPC error.
- **If `MCP_API_KEY` is unset**, auth is disabled (useful for local development).

### Setting the key in production (Railway)

1. Generate a strong random secret (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
2. In Railway: select the service → **Variables** tab → add `MCP_API_KEY=<your-secret>` → Save (Railway auto-redeploys)
3. In Prompt Opinion: open the MCP server entry → set **Authentication Type** to API Key → **Header Name** = `X-API-Key`, **Header Value** = `<your-secret>` → Save

### Why this matters

A publicly-reachable MCP endpoint with no auth is open to anyone who knows the URL. Requiring an API key prevents random callers from invoking the tools, consuming FHIR budget, or triggering downstream LLM costs. Approved evaluators can request the key from the publisher contact below.

## Server logs

The server logs each MCP request with SHARP header status:

```
[MCP] method=tools/call | x-patient-id=9e3eb5d8-... | x-fhir-server-url=https://app.promptopinion.ai/...
[MCP]   tool=AssessMaternalRisk args={} token=YES
```

| Field | Meaning |
|---|---|
| `method` | MCP protocol method (initialize, tools/list, tools/call) |
| `x-patient-id` | Patient UUID from SHARP headers (MISSING if no patient selected) |
| `x-fhir-server-url` | Workspace FHIR endpoint (MISSING if not forwarded) |
| `token` | Whether an access token was forwarded (YES/NO) |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Only `initialize` and `tools/list` in logs, no `tools/call` | Agent isn't invoking tools | Use explicit prompt: "Use the AssessMaternalRisk tool..." |
| `x-patient-id=MISSING` on `tools/call` | Patient not selected or Patient Context not enabled | Select a patient in the picker AND enable Patient Context on the BYO Agent |
| `x-fhir-server-url=MISSING` | Workspace Context not enabled | Enable Workspace Context on the BYO Agent |
| Tool returns "FHIR context could not be retrieved" | SHARP headers not forwarded | Check MCP server has "Requires Patient Data Access" enabled |
| Tool returns empty conditions/labs | Patient has no clinical data in FHIR | Import the Maria Santos bundle or add data to the patient |
| `502 Bad Gateway` on bundle import | Bundle too large for gateway timeout | Split into smaller bundles |
| Bundle imports as "success" but patient doesn't appear | Patient missing `identifier` array | Add `identifier` with system + value to the Patient resource |
| Collection retrieval not firing on specialist agent (LLM responds with "I cannot access external documents" or hallucinates guideline quotes; input token count stays low) | "Disable Embedded Tools" is toggled ON — this blocks the `SearchSources` retrieval tool that grounded Collections depend on | Turn "Disable Embedded Tools" OFF in the agent's Tools tab → Save → retest |
| Orchestrator agent calls `GetPatientData` / `GetPatientDocuments` directly instead of delegating to the specialist via A2A | Embedded tools are available AND the system prompt doesn't explicitly forbid them for clinical triage | Update the orchestrator system prompt to explicitly block those tools for clinical reasoning and require delegation to Prenatal Visit Prep — see the Orchestrator Agent section for the final prompt |
| Orchestrator hallucinates `SendA2AMessage` with fake UUIDs (e.g. `a1b2c3d4-...`); response says "Simulated A2A Response" | The `{{ OrchestratorAgentsFragment }}` template variable is missing from the orchestrator's system prompt, so the LLM doesn't know the real agent IDs | Include `{{ OrchestratorAgentsFragment }}` near the top of the orchestrator system/consultation prompts |
| 401 from `/mcp` with "Unauthorized: invalid or missing X-API-Key header" | MCP server has `MCP_API_KEY` env var set on Railway but the request isn't sending a matching header | In Po → MCP Servers → MaternalGuard → set Authentication Type to API Key, Header Name `X-API-Key`, Header Value = your secret |

## Contact

Built by Jonathan Andrei ([jonathanandrei.com](https://jonathanandrei.com)) under the publishing identity **JonathanSolvesProblems**. For API key access (anyone evaluating the deployed Railway endpoint in their own Prompt Opinion workspace), email **jonathan@jonathanandrei.com**.

## License

MIT
