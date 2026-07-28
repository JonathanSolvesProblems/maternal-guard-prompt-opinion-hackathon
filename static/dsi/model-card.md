# MaternalGuard — CHAI Applied Model Card

**Version:** 0.4.0
**Published:** 2026-05-15
**Last reviewed:** 2026-07-27
**Machine-readable version:** [model-card.json](model-card.json)
**Live at:** `https://maternalguard.jonathanandrei.com/dsi/model-card.md`

This is the human-readable companion to the JSON model card that every MaternalGuard Provenance references. Both are the trust-story artifact for ONC HTI-1 45 CFR 170.315(b)(11)(iv)(A) Evidence-Based Decision Support Intervention source-attribute transparency.

---

## Publisher

MaternalGuard hackathon team.
Contact: `jonathan@jonathanandrei.com`.
**No legal entity backs this artifact.** This is a hackathon prototype. Use in research and demonstration only, not clinical deployment without a covered-entity sponsor.

---

## Intervention

- **Name:** MaternalGuard Pregnancy Guard
- **Identifier:** `mg-dsi-v0.4.0` in system `https://maternalguard.local/dsi`
- **DSI class:** Evidence-Based (per 45 CFR 170.315(b)(11)(iv)(A))
- **Algorithm methodology:** Rule-based. No machine learning training data.

---

## The 13 (b)(11)(iv)(A) source attributes

Every one of these is ALSO carried inline on every Provenance the server writes, so a viewer that renders the Provenance without following DocumentReference references still sees the transparency summary.

| Attribute | Value |
|---|---|
| **Intervention name** | MaternalGuard Pregnancy Guard |
| **Intervention identifier** | `mg-dsi-v0.4.0` |
| **Purpose** | Flag postpartum and prenatal encounters (ICD-10 Z3A, Z34) with a rule-based guard that drafts a Task for clinician review. Never auto-writes to the chart. |
| **Intended population** | Adult patients (18+) with a current or recent pregnancy encounter in an outpatient obstetric or primary-care setting. |
| **Cautioned out-of-scope use** | Not for pediatric obstetrics, not for pregnancy loss / fetal demise workflows without human triage, not for acute L&D decisioning. |
| **Algorithm methodology** | Rule-based. |
| **Underlying knowledge source** | ICD-10-CM Z3A/Z34 code families; ACOG Practice Bulletins (PB #190, #201, #203, #222, #229, #234); IADPSG criteria; NCQA HEDIS PPC (NQF #1517); LOINC-coded observations. Full list under **Bibliography** below. |
| **Developer** | MaternalGuard hackathon team; prototype only, no legal entity. |
| **Funding source** | Unfunded hackathon submission. |
| **Release date** | 2026-05-15 |
| **Version** | 0.4.0 |
| **Bias assessment** | Rules operate on structured FHIR fields (ICD-10, LOINC) only; no free-text scoring. False-positive rate < 1% on a 61-case corpus balanced across race, ethnicity, language, sex, and age. The Advanced Maternal Age flag (>=35, female-only) is a clinical necessity per ACOG Committee Opinion #706, not demographic profiling. |
| **Warnings and limitations** | Draft-only writer: every Task ships with `status=requested`, every Flag with `status=inactive`; both require explicit clinician approval. Never asserts a diagnosis. Never orders labs. Never contacts patients. Not validated against a live prospective cohort. Not a replacement for MFM consult in HELLP-suspicion cases. |
| **Regulatory framework** | 45 CFR 170.315(b)(11)(iv)(A); ONC HTI-1 final rule (89 FR 1192, 11 Mar 2024); HL7 AI Transparency on FHIR IG v1.0.0-ballot. |

---

## Safety and oversight

- **Human oversight required:** yes.
- **Output actionability:** all draft. Nothing MaternalGuard writes is autonomous.
- **Autonomous actions:** none.
- **Override mechanism:** the clinician reviews each drafted Task/Flag on the Morning Huddle dashboard and clicks Approve / Reject / Activate / Dismiss. Every state transition is Provenance-audited and appears in the Recently actioned section. Server-side transition guards refuse illegal transitions (e.g., re-approving an already-accepted Task returns a soft "already actioned" toast, not a silent overwrite).
- **Known failure modes:**
  1. FHIR read failure on a lab type → tool soft-degrades with `status: "no-op"`, `blocksNextStep: false`. Never blocks downstream tools.
  2. Stringified tool arguments from upstream agent → tool schema unions accept both shapes and coerce server-side.
  3. Duplicate draft Flags from parallel `ProposeMaternalAction` calls → server-side dedup by `code.text` on the same patient before FHIR create.

---

## Fairness and equity

**Population strata considered:**
- Sex: female only (clinically definitional for pregnancy).
- Age: >=18 (adult obstetric care). Advanced Maternal Age flag applies at >=35 per ACOG Committee Opinion #706.
- Language: SDOH tool flags non-English primary language as an interpreter-services signal, never as a risk factor.

**Known equity risks:**
- SDOH signals (no insurance, missing contact info, non-English primary language) are surfaced as follow-up-coordination flags. They must never be used to gate care.
- The bundled synthetic cohort (Synthea) is not race/ethnicity balanced to the US pregnant population. Prospective validation on a demographically representative cohort is required before any deployment.

---

## Provenance and traceability

**Output attribution:**
- Profile: `http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-Provenance`
- Security label: `AIAST` (Artificial Intelligence Asserted, HL7 v3 ObservationValue)

**Audit trail:** every write emits a FHIR Provenance resource referencing the target Task or Flag, with:
- A contained `AI-Device` (`aiKind=rule-based`, DSI identifier `mg-dsi-v0.4.0`)
- A contained `AI-ModelCard` DocumentReference pointing at [this JSON](model-card.json) and this Markdown
- All 13 source attributes carried ALSO inline for hosts that do not follow references

---

## Bibliography

- ACOG Practice Bulletin #190: Gestational Diabetes Mellitus
- ACOG Practice Bulletin #201: Pregestational Diabetes Mellitus
- ACOG Practice Bulletin #203: Chronic Hypertension in Pregnancy
- ACOG Practice Bulletin #222: Preeclampsia
- ACOG Practice Bulletin #229: Antepartum Fetal Surveillance
- ACOG Practice Bulletin #234: Antenatal Corticosteroid Therapy for Fetal Maturation
- ACOG Committee Opinion #706: Advanced Maternal Age
- ACOG Committee Opinion #765: Avoidance of Nonmedically Indicated Early-Term Deliveries
- IADPSG criteria for GDM diagnosis
- NCQA HEDIS Prenatal & Postpartum Care measure specification (NQF #1517)
- CDC Pregnancy Mortality Surveillance System, 2020

---

## Change log

**0.4.0 — 2026-07-27**
- Published Model Card to a resolvable HTTPS URL (was `maternalguard.local` placeholder).
- Documented stringified-argument fixes across all 5 data tools.
- Documented dashboard optimistic-toast + inline confirmation banner patterns.
- Added CHAI Applied Model Card top-level sections (safetyAndOversight, fairnessAndEquity, provenanceAndTraceability, bibliography, changeLog).

**0.3.1 — 2026-05-15**
- Initial hackathon submission version.
- 13 (b)(11)(iv)(A) source attributes carried inline on every Provenance summary extension.

---

*This ongoing versioning is the (b)(11) "ongoing maintenance" surface the ONC HTI-1 rule expects to see used. Each version bump touches this file, the JSON, and the `MATERNALGUARD_DSI_VERSION` constant in [src/clinical/fhir-builders.ts](../../src/clinical/fhir-builders.ts) at the same time.*
