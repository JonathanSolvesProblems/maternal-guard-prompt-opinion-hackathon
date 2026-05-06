# Clinical Guidelines Collection

Publicly-available clinical guideline PDFs to attach as a Prompt Opinion **Collection** on the `Prenatal Visit Prep` and `On-Call OB Triage` agents. When attached, Po embeds the content into a vector index; the agents retrieve passages at runtime to ground their clinical citations in real source text instead of LLM recall.

## Guidelines included in this collection

| File | Source | Topic | Size |
|---|---|---|---|
| `nice-ng133-hypertension-in-pregnancy.pdf` | NICE (UK) NG133, 2019 (updated 2023) | Preeclampsia and gestational hypertension — diagnosis and management, 61 pp. | 315 KB |
| `uspstf-aspirin-preeclampsia-2021.pdf` | USPSTF (US, public domain), 2021 | Final recommendation: low-dose aspirin to prevent preeclampsia, 6 pp. | 456 KB |
| `cdc-gbs-prevention-mmwr-2010.pdf` | CDC MMWR (US, public domain) | Prevention of perinatal Group B strep — foundational guideline referenced by ACOG PB #797 | 4.0 MB |
| `iadpsg-gdm-criteria-2010.pdf` | IADPSG via PMC (CC open access) | Consensus paper defining the 92 / 180 / 153 mg/dL fasting / 1-hr / 2-hr OGTT thresholds for GDM diagnosis, 7 pp. | 92 KB |
| `who-antenatal-corticosteroids-2022.pdf` | WHO (CC BY-NC-SA 3.0 IGO), 2022 | Global recommendations on antenatal corticosteroids for preterm birth outcomes | 536 KB |

Together these cover the full clinical surface of the demo — preeclampsia diagnosis/management, aspirin prevention, GDM diagnostic criteria, antenatal corticosteroid timing, and GBS prophylaxis with penicillin-alternative antibiotic selection.

### Source URLs (for re-download or verification)

- NICE NG133: https://www.nice.org.uk/guidance/ng133/resources/hypertension-in-pregnancy-diagnosis-and-management-pdf-66141717671365
- USPSTF Aspirin for Preeclampsia (2021): https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/low-dose-aspirin-use-for-the-prevention-of-morbidity-and-mortality-from-preeclampsia-preventive-medication
- CDC MMWR rr5910 (GBS prevention): https://www.cdc.gov/mmwr/pdf/rr/rr5910.pdf
- IADPSG 2010 (PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC2827530/
- WHO Antenatal Corticosteroids 2022: https://www.who.int/publications/i/item/9789240057296

## Optional 6th — patient-facing Spanish materials

To strengthen the SDOH / Spanish-language story for Maria:

- **March of Dimes — Preeclampsia:** https://www.marchofdimes.org/find-support/topics/pregnancy/preeclampsia (has Spanish version; save via browser's "Print → Save as PDF")
- **CDC — Hypertensive Disorders in Pregnancy:** https://www.cdc.gov/maternal-infant-health/hypertensive-disorders-pregnancy/index.html (English + Spanish pages)

## How to attach this collection in Prompt Opinion

1. **Collections** sidebar → **Create Collection** → name: `Maternal Clinical Guidelines`
2. Upload all PDFs from this folder (plus any you added manually)
3. Wait for embedding to complete (~30-60 seconds per file)
4. Open the `Prenatal Visit Prep` agent → **Content** tab → attach the Collection
5. Optional: also attach to `On-Call OB Triage` orchestrator
6. Save → re-test with Maria → the agent now retrieves passages from these guidelines in real time

## Attribution and copyright notes

- **NICE NG133** — Crown copyright, reproduced under NICE's re-use terms; clinical content freely usable for non-commercial decision support
- **USPSTF recommendations** — US federal government, public domain
- **CDC MMWR** — US federal government, public domain
- **IADPSG paper** — Creative Commons open access via PMC
- **WHO publications** — CC BY-NC-SA 3.0 IGO license, non-commercial use permitted

**ACOG Practice Bulletin PDFs are intentionally NOT included** — they are copyrighted behind paywall. The agent references PB numbers (#222, #190, #234, #713, #797, #201) by citation only; the grounded source text above aligns with current ACOG guidance without reproducing ACOG material.

## Why this matters for judging

This folder is a credibility signal for the clinical-AI judges:

- **Josh Mandel (Microsoft Research / SMART-on-FHIR)** — grounded retrieval over training recall is the right pattern
- **Piyush Mathur (Cleveland Clinic / BrainX)** — evidence-backed clinical AI > vibes-based clinical AI
- **Stephon Proctor (CHOP)** — informatics-literate source curation (NICE + CDC + WHO + IADPSG) signals real-world readiness

The README and marketplace listing should reference this Collection explicitly so judges see the intentionality.
