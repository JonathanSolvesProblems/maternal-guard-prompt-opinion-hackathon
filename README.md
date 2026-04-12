# MaternalGuard

An MCP server that surfaces maternal health risk signals from FHIR patient data, built for the [Agents Assemble hackathon](https://agents-assemble.devpost.com/) on the [Prompt Opinion](https://app.promptopinion.ai) healthcare AI platform.

MaternalGuard reads pregnant patients' clinical data (demographics, conditions, vitals, labs, medications, social history, care plans) from a FHIR R4 server and returns it as structured, decision-ready context for the platform's AI to reason over. It does not call any LLM directly — all reasoning happens in Prompt Opinion.

## Why This Matters

Maternal mortality in the US has been rising for decades. Over 80% of pregnancy-related deaths are preventable, and the leading contributors — preeclampsia, hemorrhage, cardiomyopathy — leave clinical signals scattered across vitals, labs, and social history that no single provider sees in one place. Black and Indigenous women face 3-4x higher mortality rates, often compounded by SDOH barriers like insurance gaps, language barriers, and transportation access.

MaternalGuard gives AI the structured context it needs to connect these dots: flagging that a rising BP trend + new proteinuria + falling platelets = HELLP risk, or that a Spanish-speaking Medicaid patient in a food desert needs interpreter services and WIC continuation alongside her preeclampsia monitoring.

## The 4 Tools

| Tool | What it does | Key FHIR resources |
|---|---|---|
| `AssessMaternalRisk` | Pulls demographics, conditions, vitals, labs, and meds. Flags high-risk ICD-10 codes (O14 preeclampsia, O24 GDM, O10/O11 chronic HTN, E10/E11 diabetes, etc.) and advanced maternal age (>=35). | Patient, Condition, Observation, MedicationRequest |
| `ScreenSocialDeterminants` | Pulls insurance, address, contact info, language, and social history observations. Flags barriers: missing coverage, non-English primary language, missing contact info, absent SDOH screening. | Patient, Coverage, Observation (social-history) |
| `InterpretLabTrends` | Fetches longitudinal labs/vitals by LOINC code. Returns chronological readings with pregnancy-specific reference ranges and trend statistics (min/max/mean). | Observation (by LOINC code) |
| `GenerateCarePlan` | Pulls conditions, allergies, meds, and existing care plans. Returns ACOG-aligned screening recommendations for the gestational age + a FHIR R4 CarePlan template. | Patient, Condition, AllergyIntolerance, MedicationRequest, CarePlan |

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
Prompt Opinion (LLM + UI)
        |  POST /mcp + SHARP headers
        v
   ngrok tunnel
        |
        v
  Express server (port 5000)
        |  fetches via FHIR R4 REST
        v
  Workspace FHIR store
```

- **TypeScript + Express 5** + `@modelcontextprotocol/sdk`
- Each `/mcp` POST spins up a fresh `McpServer` per request using `StreamableHTTPServerTransport` (stateless mode, no session management)
- Tools read SHARP context off the inbound request headers, then call the workspace FHIR endpoint with the bearer token
- The `ai.promptopinion/fhir-context` extension is declared in capabilities so the platform knows to forward FHIR context

## Project layout

```
index.ts                          Express server + /mcp + /health endpoints
src/
  tools/
    AssessMaternalRiskTool.ts     Risk assessment: conditions, vitals, labs, meds
    ScreenSocialDeterminantsTool.ts  SDOH screening: insurance, language, social hx
    InterpretLabTrendsTool.ts     Lab trends with pregnancy reference ranges
    GenerateCarePlanTool.ts       Care plan: allergies, meds, ACOG schedule
    index.ts                      Tool barrel export
  fhir-client.ts                  FHIR R4 HTTP client (uses SHARP headers)
  fhir-utilities.ts               Extracts SHARP context from request headers
  fhir-context.ts                 FhirContext type definition
  mcp-constants.ts                Header name constants
  mcp-utilities.ts                Response helpers (text + JSON)
  null-utilities.ts               Null-safe helpers
  IMcpTool.ts                     Tool interface
test-patient-maria-santos.json    Sample FHIR bundle (see Test Patient section)
```

## Running locally

You'll need Node.js 18+ and a free [ngrok](https://ngrok.com/) account.

```bash
npm install
npx tsx index.ts          # starts on port 5000
```

In a second terminal:

```bash
npx ngrok http 5000
```

Copy the `https://<random>.ngrok-free.app` URL. The MCP endpoint is `https://<random>.ngrok-free.app/mcp`.

## Setting up in Prompt Opinion

### 1. Register the MCP server

- **MCP Servers -> Add Server**
- **Endpoint:** `https://<your-ngrok>.ngrok-free.app/mcp`
- **Requires Patient Data Access:** enable this toggle
- Save. The platform will probe the server and discover the 4 tools.

### 2. Import the test patient (Maria Santos)

The included `test-patient-maria-santos.json` is a FHIR R4 batch bundle with a 28-year-old pregnant patient at 32 weeks gestation, designed to exercise all 4 tools.

- **FHIR Bundle Import -> Upload File**
- Select `test-patient-maria-santos.json`
- Wait for the success message
- **Maria Elena Santos** (DOB 1997-08-15) should appear in the patient list

> **Bundle format notes:** Every entry has a real-UUID `fullUrl`, requests use `POST` (not `PUT`), and the Patient has an `identifier` array. These are platform requirements.

### 3. Set up a BYO Agent

- **Agents -> New BYO Agent**
- **Tools / MCP servers:** attach your MaternalGuard MCP server
- **Patient Context:** enabled
- **Workspace Context:** enabled
- Save

### 4. Select a patient and run prompts

Select **Maria Santos** from the patient picker, then launch the BYO agent and run the test cases below.

## Test Patient: Maria Elena Santos

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
- **ACOG guidelines:** High-risk visit schedule (every 1-2 weeks), standard prenatal labs listed
- **FHIR CarePlan template:** Provided for the AI to populate with activities

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

### Test 6: Minimal patient (judges testing with other patients)

MaternalGuard works with **any** patient in the workspace — not just Maria. When tested with a patient that has minimal data (e.g., the built-in sample patients):

- `AssessMaternalRisk` will return demographics and flag advanced maternal age if applicable, and note empty conditions/labs/meds
- `ScreenSocialDeterminants` will flag missing insurance, missing social history screening, and missing contact info as barriers
- `InterpretLabTrends` will return "No observation data found" — this is correct, not an error
- `GenerateCarePlan` will return minimal conditions and suggest determining gestational age to guide screening schedule

This graceful degradation is by design — the tools report what data exists and flag what's missing, rather than failing.

---

## Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/mcp` | POST | MCP protocol endpoint (initialize, tools/list, tools/call) |
| `/health` | GET | Health check + tool list |

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

## License

MIT
