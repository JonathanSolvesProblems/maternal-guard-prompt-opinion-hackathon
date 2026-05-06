# Test Cases

Synthetic patient data for demonstrating and testing MaternalGuard.

## Contents

```
test-cases/
├── patient-maria-santos-bundle.json      FHIR R4 batch bundle (40+ resources)
└── documents/
    └── maria-santos/                     Clinical notes (optional UI upload)
        ├── prenatal-visit-note-2026-04-04.md
        ├── mfm-consult-note-2026-03-21.md
        └── prior-delivery-discharge-summary-2023-06-10.md
```

## How to use

### 1. Import the FHIR bundle

In Prompt Opinion: **FHIR Bundle Import → Upload File → `patient-maria-santos-bundle.json`**

This creates Maria Elena Santos (DOB 1997-08-15) with all her clinical data — conditions, observations, medications, allergies, care plan, and social history — attached to her FHIR record. The bundle uses `batch` type with `POST` requests, real-UUID `fullUrl` values, and US Core profile declarations where applicable.

### 2. (Optional) Upload the clinical documents

For extra demo realism, upload the markdown files in `documents/maria-santos/` via the patient's **Upload Document** feature in Prompt Opinion. These are the kind of narrative notes a clinician would write during visits — they don't drive MaternalGuard's tool behavior (our tools read structured FHIR resources), but they make the chart look lived-in for the demo.

> Note: as of writing, documents uploaded via the UI don't reliably surface as FHIR `DocumentReference` resources via the FHIR API. The markdown files here are for visual demo fidelity, not for tool input.

## Patient scenario summary

**Maria Elena Santos** — 28yo Hispanic/Latina female, G2P1 at 32 weeks gestation, married, Chicago IL, primary language Spanish, Medicaid coverage.

| Axis | Details |
|---|---|
| Active conditions | Mild-moderate preeclampsia (O14.00), GDM (O24.410), 32-week pregnancy (Z34.32) |
| Inactive conditions | Prior preterm birth at 34 weeks (O09.21, 2023) |
| Key lab trajectory | BP 118/72 → 148/95; AST 38 → 54 U/L; platelets 162K → 141K; proteinuria 35 → 42 mg/dL; uric acid 6.9 |
| Medications | Labetalol 200mg BID, Metformin 500mg BID, ASA 81mg daily, prenatal vitamins |
| Allergies | Penicillin (low severity — rash) |
| SDOH | Spanish primary, food insecurity at-risk, intermittent transportation, part-time employment |
| Active care plan | High-Risk Prenatal Care Plan — Preeclampsia + GDM |

**Clinical narrative the AI should recognize:** The constellation of rising BP, rising AST, falling platelets, rising proteinuria, and elevated uric acid at 32 weeks is a classic preeclampsia → HELLP evolution pattern. Combined with Spanish language barrier and transportation gaps, this patient needs close monitoring, interpreter-supported counseling, and preparation for possible iatrogenic preterm delivery (with neonatal/NICU readiness including antenatal corticosteroid counseling under ACOG PB #234).
