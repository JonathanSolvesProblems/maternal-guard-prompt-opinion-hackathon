# Verification Walkthrough

A sequential, top-to-bottom checklist to confirm the MaternalGuard stack works end-to-end. Each phase lists explicit prompts, expected behavior, key assertions, and a pass/fail checkbox. If a phase fails, the troubleshooting table in the main README explains how to fix it.

---

## Phase 0 · Pre-flight (5 min)

Before any prompt-level testing, confirm infrastructure is up.

| # | Check | How to verify | Pass criteria |
|---|---|---|---|
| 0.1 | Railway deployment is live | Browser → `https://promptopinion-hackathon-production.up.railway.app/health` | Returns JSON with `status: "healthy"` and the 5 tool names listed |
| 0.2 | API key auth is enforced | `curl -X POST https://promptopinion-hackathon-production.up.railway.app/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'` (no `X-API-Key` header) | Returns HTTP 401 with `{"error":{"code":-32001,"message":"Unauthorized: invalid or missing X-API-Key header"}}` |
| 0.3 | Po MCP server registration is correct | Po → MCP Servers → MaternalGuard | Endpoint = `https://promptopinion-hackathon-production.up.railway.app/mcp`; Authentication Type = API Key; Header Name = `X-API-Key`; Header Value matches Railway env var |
| 0.4 | Maria Santos imported | Po → patient picker → search "Santos" | "Santos, Maria Elena" with DOB `1997-08-15` appears |
| 0.5 | Both agents exist | Po → Agents | `Prenatal Visit Prep` (BYO) and `On-Call OB Triage` (Orchestrator) both listed |
| 0.6 | Specialist tool config | Prenatal Visit Prep → Tools tab | MaternalGuard MCP attached; "Disable Embedded Tools" = OFF (retrieval depends on this) |
| 0.7 | Specialist Collection attached | Prenatal Visit Prep → Content tab | Workspace collection = `Maternal Clinical Guidelines` selected; all 5 PDFs show as embedded |
| 0.8 | Orchestrator linked agent | On-Call OB Triage → Linked Agents tab | `Prenatal Visit Prep` listed |
| 0.9 | Guardrail attached | Prenatal Visit Prep → Guardrails tab | `safety_footer_enforcement` shown; validator model has live API key (not exhausted) |
| 0.10 | BYO model has credits | Provider account billing dashboard (OpenAI / Anthropic) | Sufficient credit for ~30 test runs (~$1 minimum on Sonnet 4.6 / GPT-4.1) |
| 0.11 | Railway logs accessible | Railway → service → Deployments → View Logs | Logs streaming live; ready to watch tool calls |

**Phase 0 pass:** ☐ All 11 boxes checked

---

## Phase 1 · Per-tool smoke tests (10 min)

Goal: confirm each MCP tool fires individually and returns real Maria data. Run these from **Prenatal Visit Prep** with Maria selected. Use prompts that explicitly name the tool to force isolated invocation.

### Test 1.1 — `AssessMaternalRisk`

**Prompt:**
```
Use ONLY the AssessMaternalRisk tool to assess this patient's maternal risk. Do not call any other MaternalGuard tools.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `AssessMaternalRisk` (the only MaternalGuard tool that should fire) |
| Risk flags include | "High-risk condition: Mild to moderate pre-eclampsia (O14.00)"<br>"High-risk condition: Gestational diabetes mellitus in pregnancy (O24.410)" |
| ACOG references include | "ACOG PB #222 (Preeclampsia)" and "ACOG PB #190 (GDM)" |
| Active conditions list shows | Preeclampsia, GDM, Pregnancy 32 weeks (Z34.32) |
| Recent vitals include | BP 148/95 on 2026-04-04, weight 76.8 kg |
| Active medications list | Labetalol 200mg, Metformin 500mg, Aspirin 81mg, Prenatal Vitamins |
| Railway log line for the tool call | `[MCP] method=tools/call ... tool=AssessMaternalRisk ... token=YES` |

**Pass:** ☐

---

### Test 1.2 — `InterpretLabTrends`

**Prompt:**
```
Use ONLY the InterpretLabTrends tool to analyze this patient's lab and vital trends. She is at 32 weeks gestation. Do not call any other tools.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `InterpretLabTrends` only |
| Tool args | Should include `gestationalAgeWeeks: 32` |
| Returned trends include | BP (4 readings, 118/72 → 148/95), Hemoglobin (11.8 → 10.9), Platelets (162 → 141), AST (38 → 54), Uric acid (6.9), Urine protein (35 → 42), Glucose, Fasting glucose, Body weight |
| Reference ranges visible | Pregnancy-specific (e.g., "150,000-400,000/uL (<100,000 concerning for HELLP)") |
| Statistics (min/max/mean/count) | Present for each lab type |

**Pass:** ☐

---

### Test 1.3 — `ScreenSocialDeterminants`

**Prompt:**
```
Use ONLY the ScreenSocialDeterminants tool to assess this patient's social determinants of health.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `ScreenSocialDeterminants` only |
| Languages array includes | Spanish (preferred=true), English (preferred=false) |
| Insurance coverage | Medicaid (active) |
| Social history observations include | Employment "Part-time employed", Food insecurity "At risk", Transportation "Sometimes" |
| Potential barriers flagged | "Primary language is not English — interpreter services may be needed" |

**Pass:** ☐

---

### Test 1.4 — `GenerateCarePlan`

**Prompt:**
```
Use ONLY the GenerateCarePlan tool. Risk level is "high", patient is at 32 weeks gestation.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `GenerateCarePlan` only |
| Tool args | `riskLevel: "high"`, `gestationalAgeWeeks: 32` |
| Active conditions | Preeclampsia, GDM, Pregnancy 32w, History of preterm birth |
| Allergies include | Penicillin (low criticality) |
| Current medications | Labetalol, Metformin, Aspirin, Prenatal Vitamins |
| Existing care plans | "High-Risk Prenatal Care Plan — Preeclampsia + GDM" (active) |
| Recommended screenings include | "More frequent BP monitoring [ACOG PB #222]"<br>"Serial growth ultrasounds every 3-4 weeks [ACOG PB #229]"<br>"Antenatal corticosteroids counseling for fetal lung maturity [ACOG PB #234]" |

**Pass:** ☐

---

### Test 1.5 — `PredictNeonatalImpact`

**Prompt:**
```
Use ONLY the PredictNeonatalImpact tool. Patient is at 32 weeks gestation. What does the NICU team need to prepare for?
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `PredictNeonatalImpact` only |
| Tool args | `gestationalAgeWeeks: 32` |
| Prematurity band | "Moderate preterm (32-33 weeks)" with ACOG PB #234 reference |
| Maternal risk drivers include | Preeclampsia (O14.00) → IUGR / NICU / iatrogenic preterm risks; GDM (O24.410) → macrosomia / hypoglycemia / RDS; Platelets 141 below threshold |
| Neonatal readiness checklist includes | Antenatal corticosteroids counseling (ACOG PB #234), neonatology team notification, newborn glucose monitoring, NICU level assessment |

**Pass:** ☐

---

## Phase 2 · End-to-end specialist (Prenatal Visit Prep) (3 min)

Goal: confirm all 5 tools fire together AND grounded Collection retrieval activates AND guardrail approves AND brief is well-formed.

### Test 2.1 — Full pre-visit brief

**Prompt:**
```
Prep me for tomorrow's visit with this patient.
```

| Expected | Pass criteria |
|---|---|
| Tool calls fired (in any order) | All 5 MaternalGuard tools: AssessMaternalRisk, ScreenSocialDeterminants, InterpretLabTrends, GenerateCarePlan, PredictNeonatalImpact |
| Token count | Input >12K (full tool outputs + Collection retrieval injected) |
| Brief contains all 6 sections | Headline risk · Trajectory · Contributing SDOH · Care plan gaps · Neonatal/NICU readiness · Recommended next actions |
| HELLP trifecta surfaced | Brief explicitly mentions rising AST + falling platelets + elevated uric acid + rising proteinuria as a constellation |
| ACOG PB numbers cited | At least PB #222 (preeclampsia), PB #190 (GDM), PB #234 (corticosteroids) |
| LOINC codes inline | At least one tracked value cited with its LOINC (e.g., AST 1920-8, Platelets 777-3) |
| Penicillin allergy | Mentioned in care plan / GBS planning section |
| Spanish primary language flagged | In Contributing SDOH section |
| Mother-baby connection | Explicit (e.g., "rising GDM glucose → macrosomia/hypoglycemia risk") |
| Final line | "Clinician review required before any action." |
| No hallucinated values | Every BP, lab, etc. matches Maria's actual data — see [Maria's reference values](#marias-reference-values) below |
| Guardrail decision | Response delivered (not rejected) |

**Pass:** ☐

---

## Phase 3 · Collection retrieval verification (2 min)

Goal: confirm the grounded clinical-guidelines Collection is being retrieved (not LLM-recall-only).

### Test 3.1 — Document-targeted retrieval

**Prompt:**
```
Using the NICE NG133 document from my grounding collection, what blood pressure thresholds does it define for mild, moderate, and severe hypertension in pregnancy? Quote the specific passage from the document.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `SearchSources` (Po's embedded retrieval tool). Its presence in the trace is the definitive signal that vector retrieval fired against the attached Collection. |
| Token count | Input >5K (chunks injected) — vs ~1.6K when retrieval fails |
| Numeric thresholds returned | **Mild: 140-149/90-99**, **Moderate: 150-159/100-109**, **Severe: ≥160/110** (NOT ≥170/110, which would indicate hallucination) |
| Quoted passage present | Direct quote from NICE NG133 (e.g., references CHIPS study, NICE adults guideline) |

**Pass:** ☐ ⚠️ Critical — if this fails, see [README troubleshooting](../README.md#troubleshooting) for "Collection retrieval not firing"

---

### Test 3.2 — IADPSG GDM thresholds (different document)

**Prompt:**
```
Using the IADPSG 2010 paper from my grounding collection, what are the specific OGTT thresholds for diagnosing gestational diabetes? Quote the passage.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `SearchSources` |
| Numeric thresholds returned | Fasting ≥92 mg/dL, 1-hour ≥180 mg/dL, 2-hour ≥153 mg/dL |
| Source named | IADPSG / Diabetes Care reference |

**Pass:** ☐

---

## Phase 4 · Orchestrator A2A delegation (3 min)

Goal: confirm the Orchestrator agent successfully delegates to the specialist via A2A and produces a triage disposition.

### Test 4.1 — Acute symptom triage

**Setup:** Switch to **On-Call OB Triage** agent. With Maria selected, **set the "Consult with another agent" dropdown to `Prenatal Visit Prep - (Workspace Agent)`**.

**Prompt** (explicit language request reliably produces the bilingual output):
```
Maria reports a severe headache and blurry vision at 32 weeks. She speaks Spanish — please include a Spanish summary for her in your triage. Triage now.
```

| Expected | Pass criteria |
|---|---|
| Tool calls visible | `SendAgentMessage` (or similar A2A tool) → Prenatal Visit Prep<br>**Underneath:** the 5 MaternalGuard tools fire on the specialist side |
| **NO** hallucinated UUIDs | No `SendA2AMessage` calls with fake `a1b2c3d4-e5f6-...` agent IDs |
| **NO** "Simulated A2A Response" text | Anywhere in the output |
| **NO** standalone GetPatientData / GetPatientDocuments | The orchestrator must delegate, not shortcut |
| Token count | Input >5K (specialist brief embedded) |
| TRIAGE DISPOSITION present | One of: REASSURANCE / OFFICE VISIT / L&D EVALUATION / EMERGENCY |
| Driving findings cite | Specific values + dates (e.g., "BP 148/95 on 2026-04-04", "AST 54 U/L") |
| Spanish summary present | Uses correct medical terminology — "sala de labor y parto" or "sala de partos", **NOT "laboratorio"** |
| Final line | "Clinician review required before any action." |

**Pass:** ☐

---

### Test 4.2 — Sanity check: Railway logs show no FHIR 403s during 4.1

After Test 4.1 completes, check Railway logs for the time window of that test.

| Expected | Pass criteria |
|---|---|
| Each MCP tool call | Returns 200 from FHIR endpoint (visible in tool call latency / success in logs) |
| No 403 errors | Zero `403` responses on FHIR API calls (would indicate the consult-flow-no-patient-scopes bug raised in Discord) |

**Pass:** ☐ (If 403s present, the orchestrator data may be hallucinated. Use Prenatal Visit Prep directly as a fallback path.)

---

## Phase 5 · Edge cases & corner scenarios (3 min)

### Test 5.1 — Penicillin allergy + GBS prophylaxis reasoning

**Prompt** (from Prenatal Visit Prep, Maria selected):
```
This patient has a penicillin allergy and is approaching 36 weeks. What GBS prophylaxis alternative should we use? Cite ACOG.
```

| Expected | Pass criteria |
|---|---|
| Allergy retrieved from FHIR | "Penicillin (low severity)" referenced explicitly |
| Recommended alternative | **Cefazolin** (for low-severity PCN allergy per ACOG PB #797) — NOT penicillin |
| Mentions clindamycin/vancomycin | As alternatives for anaphylactic-severity allergies (shows full severity stratification) |
| ACOG PB #797 cited | Explicitly |

**Pass:** ☐

---

### Test 5.2 — Language-agnostic translation (regression check)

**Prompt** (from On-Call OB Triage, Maria selected, consult on Prenatal Visit Prep):
```
Maria reports decreased fetal movement and a headache. Triage.
```

| Expected | Pass criteria |
|---|---|
| Disposition | EMERGENCY or L&D EVALUATION (decreased fetal movement is a red flag) |
| Spanish line present | Yes (Maria is Spanish-primary) |
| Spanish line uses correct terms | "sala de labor y parto" or "sala de partos" — not "laboratorio" |
| Patient-facing tone | Direct instruction to the patient, not a clinical-note translation |

**Pass:** ☐

---

### Test 5.3 — Standalone neonatal query (PredictNeonatalImpact lead)

**Prompt** (from Prenatal Visit Prep):
```
What does my NICU team need to prepare for this patient if she delivers in the next 7 days?
```

| Expected | Pass criteria |
|---|---|
| Tool fires | At minimum `PredictNeonatalImpact` (other tools may also fire as context) |
| Mentions corticosteroid window | "ACOG PB #234" — within 7 days, before 34 weeks → eligible |
| Mentions NICU level | Level III recommended for <32w, Level II for 32-34w |
| Mentions GDM-specific neonatal risks | Macrosomia, neonatal hypoglycemia, RDS |
| Mentions preeclampsia → preterm pathway | Iatrogenic preterm delivery risk + IUGR |

**Pass:** ☐

---

## Phase 6 · Graceful degradation (2 min)

Goal: confirm tools handle data-sparse patients without hallucinating or crashing.

### Test 6.1 — Different patient (sparse data)

**Setup:** In Po patient picker, select any built-in sample patient that's NOT Maria (e.g., Janet Test or any other). With that patient selected, run Prenatal Visit Prep.

**Prompt:**
```
Prep me for tomorrow's visit with this patient.
```

| Expected | Pass criteria |
|---|---|
| Tools still fire | All 5 MaternalGuard tools |
| No hallucinated FHIR values | Response should NOT invent BP / labs / conditions Maria-specific values; should explicitly say data is missing |
| `InterpretLabTrends` behavior | Returns "No observation data found" or similar explicit absence message |
| Brief structure preserved | Still produces 6 sections, just with appropriate emptiness or "data unavailable" notes |
| Safety footer | Still present |

**Pass:** ☐

---

## Phase 7 · Final smoke test (1 min)

Run the canonical end-to-end prompt against the actual deployed stack one final time to confirm everything works clean.

**Prompt** (Prenatal Visit Prep, Maria selected):
```
Prep me for tomorrow's visit with this patient.
```

Watch the full output and time it from prompt-send to brief-rendered. If it's over 60 seconds, consider raising the agent timeout to 120 seconds.

**Pass:** ☐

---

## Maria's reference values

For checking response accuracy in any test above, Maria's actual FHIR data:

| Metric | Values | Dates |
|---|---|---|
| **Blood pressure** | 118/72 → 130/82 → 142/91 → 148/95 mmHg | 2025-11-15, 2026-02-14, 2026-03-14, 2026-04-04 |
| **Body weight** | 65.0 → 76.8 kg | 2025-11-15, 2026-04-04 |
| **OGTT 1-hr glucose** | 195 mg/dL | 2026-02-04 |
| **Fasting glucose** | 102 → 94 mg/dL | 2026-02-04, 2026-04-04 |
| **Hemoglobin** | 11.8 → 10.9 g/dL | 2025-11-15, 2026-04-04 |
| **Platelets** | 162 → 141 ×10³/µL | 2026-03-14, 2026-04-04 |
| **Urine protein (spot)** | 35 → 42 mg/dL | 2026-03-14, 2026-04-04 |
| **AST** | 38 → 54 U/L | 2026-03-14, 2026-04-04 |
| **Uric acid** | 6.9 mg/dL | 2026-04-04 |
| **Active conditions** | Preeclampsia (O14.00), GDM (O24.410), Pregnancy 32w (Z34.32) | onset 2026-03-14, 2026-02-04, 2025-08-27 |
| **Inactive conditions** | History of preterm labor (O09.21) | 2023-06-10 |
| **Allergies** | Penicillin (low criticality, rash) | — |
| **Active medications** | Labetalol 200mg BID, Metformin 500mg BID, Aspirin 81mg daily, Prenatal Vitamins | — |
| **Coverage** | Medicaid (active) | — |
| **Languages** | Spanish (preferred), English | — |
| **Address** | 847 W Cermak Rd Apt 3B, Chicago IL 60616 | — |

If a test response cites values that don't match this table, the LLM is hallucinating. Investigate before declaring the run a pass.

---

## Pass / fail summary

- **Phase 0 (pre-flight, 11 boxes):** ☐
- **Phase 1 (5 tool smoke tests):** ☐ ☐ ☐ ☐ ☐
- **Phase 2 (specialist end-to-end):** ☐
- **Phase 3 (Collection retrieval):** ☐ ☐
- **Phase 4 (orchestrator A2A):** ☐ ☐
- **Phase 5 (edge cases):** ☐ ☐ ☐
- **Phase 6 (graceful degradation):** ☐
- **Phase 7 (final smoke test):** ☐

If any phase fails, fix it via the [Troubleshooting](../README.md#troubleshooting) table in the main README before re-running.

---

## Total time estimate

| Phase | Time |
|---|---|
| 0. Pre-flight | 5 min |
| 1. Per-tool smoke (5 tests) | 10 min |
| 2. Specialist end-to-end | 3 min |
| 3. Collection retrieval (2 tests) | 2 min |
| 4. Orchestrator A2A (2 tests) | 3 min |
| 5. Edge cases (3 tests) | 3 min |
| 6. Graceful degradation | 2 min |
| 7. Final smoke test | 1 min |
| **Total** | **~30 min** |
