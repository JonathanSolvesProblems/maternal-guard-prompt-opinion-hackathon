// Deterministic maternal urgency classifier.
//
// This module is pure rules: no AI, no LLM, no model inference. Given a structured
// snapshot of a pregnant patient's vitals and labs, it returns an UrgencyAssessment
// with a band (RED / YELLOW / GREEN), a set of contributing signals, and a numeric
// score for ranking across a cohort.
//
// The deterministic-vs-generative split is the core architectural thesis:
//   - Rules handle exact, auditable thresholds and trend math (this file).
//   - Generative AI handles cross-signal narrative synthesis and SDOH reasoning
//     (the Prompt Opinion agent system prompts).
// Both layers compose. Either alone is weaker than the pair.

export type UrgencyBand = "RED" | "YELLOW" | "GREEN";

export interface VitalReading {
  date: string;
  systolicMmHg?: number | null;
  diastolicMmHg?: number | null;
}

export interface LabReading {
  code: string;
  display: string;
  value: number;
  unit?: string;
  date: string;
}

export interface UrgencySignal {
  axis:
    | "blood-pressure"
    | "ast"
    | "platelets"
    | "uric-acid"
    | "proteinuria"
    | "glucose"
    | "weight-trajectory";
  finding: string;
  severity: "mild" | "moderate" | "severe";
  rationale: string;
  guidelineReference?: string;
}

export interface UrgencyAssessment {
  band: UrgencyBand;
  score: number; // higher is more urgent; useful for cohort ranking
  signals: UrgencySignal[];
  patternFlags: string[]; // named clinical patterns triggered (e.g. "HELLP-evolution")
  reviewBy: string; // suggested review window
}

export interface UrgencyInput {
  gestationalAgeWeeks?: number | null;
  bpReadings: VitalReading[]; // chronological, oldest first
  labReadings: LabReading[];
}

// LOINC codes covered by InterpretLabTrends
const LOINC = {
  AST: ["1920-8", "30239-8"],
  PLATELETS: ["777-3", "26515-7"],
  URIC_ACID: ["3084-1", "14933-6"],
  PROTEINURIA_RANDOM: ["2888-6", "32209-9"], // urine protein
  PROTEIN_CREATININE_RATIO: ["2890-2", "34366-5"],
  FASTING_GLUCOSE: ["1558-6", "1554-5"],
};

function isPlatelets(code: string) {
  return LOINC.PLATELETS.some((c) => code.startsWith(c));
}
function isAst(code: string) {
  return LOINC.AST.some((c) => code.startsWith(c));
}
function isUricAcid(code: string) {
  return LOINC.URIC_ACID.some((c) => code.startsWith(c));
}
function isProteinuria(code: string) {
  return (
    LOINC.PROTEINURIA_RANDOM.some((c) => code.startsWith(c)) ||
    LOINC.PROTEIN_CREATININE_RATIO.some((c) => code.startsWith(c))
  );
}
function isFastingGlucose(code: string) {
  return LOINC.FASTING_GLUCOSE.some((c) => code.startsWith(c));
}

function latest<T extends { date: string }>(items: T[]): T | null {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
  return sorted[0];
}

function trend(values: number[]): "rising" | "falling" | "stable" {
  if (values.length < 2) return "stable";
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const percent = Math.abs(delta) / Math.max(Math.abs(first), 1);
  if (percent < 0.05) return "stable";
  return delta > 0 ? "rising" : "falling";
}

function chronological(labs: LabReading[]): LabReading[] {
  return [...labs].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Classify maternal urgency from structured vitals + labs.
 * Pure function, no IO. Deterministic given the same input.
 */
export function classifyUrgency(input: UrgencyInput): UrgencyAssessment {
  const signals: UrgencySignal[] = [];
  const patternFlags: string[] = [];
  let score = 0;

  // ── BLOOD PRESSURE ───────────────────────────────────────────────────────
  const latestBp = latest(input.bpReadings);
  let bpRising = false;
  if (latestBp?.systolicMmHg && latestBp?.diastolicMmHg) {
    const sys = latestBp.systolicMmHg;
    const dia = latestBp.diastolicMmHg;
    if (sys >= 160 || dia >= 110) {
      signals.push({
        axis: "blood-pressure",
        finding: `Severe-range BP (${sys}/${dia} mmHg)`,
        severity: "severe",
        rationale: "ACOG severe preeclampsia threshold: >=160/110 mmHg sustained.",
        guidelineReference: "ACOG PB #222 / NICE NG133",
      });
      score += 60;
    } else if (sys >= 140 || dia >= 90) {
      signals.push({
        axis: "blood-pressure",
        finding: `Hypertensive range BP (${sys}/${dia} mmHg)`,
        severity: "moderate",
        rationale: "Above ACOG cutoff for hypertension in pregnancy.",
        guidelineReference: "ACOG PB #222",
      });
      score += 25;
    }

    const sortedBp = [...input.bpReadings].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (sortedBp.length >= 2) {
      const sysSeries = sortedBp
        .map((b) => b.systolicMmHg)
        .filter((v): v is number => typeof v === "number");
      if (sysSeries.length >= 2 && trend(sysSeries) === "rising") {
        bpRising = true;
        const first = sysSeries[0];
        const last = sysSeries[sysSeries.length - 1];
        if (last - first >= 10) {
          signals.push({
            axis: "blood-pressure",
            finding: `Systolic BP trending upward (${first} -> ${last} mmHg)`,
            severity: "moderate",
            rationale: "Sustained upward BP trajectory is a preeclampsia evolution signal.",
            guidelineReference: "NICE NG133",
          });
          score += 15;
        }
      }
    }
  }

  // ── AST (liver enzymes) ──────────────────────────────────────────────────
  const astLabs = chronological(input.labReadings.filter((l) => isAst(l.code)));
  let astRising = false;
  if (astLabs.length) {
    const latestAst = astLabs[astLabs.length - 1];
    if (latestAst.value >= 70) {
      signals.push({
        axis: "ast",
        finding: `AST severely elevated (${latestAst.value} ${latestAst.unit || "U/L"})`,
        severity: "severe",
        rationale: "AST >=70 U/L meets ACOG severe-features preeclampsia / HELLP threshold.",
        guidelineReference: "ACOG PB #222",
      });
      score += 50;
    } else if (latestAst.value >= 40) {
      signals.push({
        axis: "ast",
        finding: `AST elevated above normal ceiling (${latestAst.value} ${latestAst.unit || "U/L"})`,
        severity: "moderate",
        rationale: "AST >40 U/L indicates hepatic stress; HELLP differential.",
      });
      score += 20;
    }
    if (astLabs.length >= 2) {
      const values = astLabs.map((l) => l.value);
      if (trend(values) === "rising" && values[values.length - 1] - values[0] >= 10) {
        astRising = true;
        signals.push({
          axis: "ast",
          finding: `AST trending upward (${values[0]} -> ${values[values.length - 1]} U/L)`,
          severity: "moderate",
          rationale: "Rising AST is a HELLP-evolution signal.",
        });
        score += 15;
      }
    }
  }

  // ── PLATELETS ────────────────────────────────────────────────────────────
  const plateletLabs = chronological(
    input.labReadings.filter((l) => isPlatelets(l.code)),
  );
  let plateletsFalling = false;
  if (plateletLabs.length) {
    const latestPlt = plateletLabs[plateletLabs.length - 1];
    if (latestPlt.value < 100) {
      signals.push({
        axis: "platelets",
        finding: `Platelets severely low (${latestPlt.value} K/uL)`,
        severity: "severe",
        rationale: "Platelets <100 K/uL meets HELLP diagnostic threshold.",
        guidelineReference: "ACOG PB #222",
      });
      score += 60;
    } else if (latestPlt.value < 150) {
      signals.push({
        axis: "platelets",
        finding: `Platelets below normal (${latestPlt.value} K/uL)`,
        severity: "moderate",
        rationale: "Thrombocytopenia; monitor for HELLP evolution.",
      });
      score += 20;
    }
    if (plateletLabs.length >= 2) {
      const values = plateletLabs.map((l) => l.value);
      if (trend(values) === "falling" && values[0] - values[values.length - 1] >= 15) {
        plateletsFalling = true;
        signals.push({
          axis: "platelets",
          finding: `Platelets trending downward (${values[0]} -> ${values[values.length - 1]} K/uL)`,
          severity: "moderate",
          rationale: "Falling platelet trajectory is a HELLP-evolution signal.",
        });
        score += 15;
      }
    }
  }

  // ── URIC ACID ────────────────────────────────────────────────────────────
  const uricAcidLabs = chronological(
    input.labReadings.filter((l) => isUricAcid(l.code)),
  );
  if (uricAcidLabs.length) {
    const latestUa = uricAcidLabs[uricAcidLabs.length - 1];
    if (latestUa.value >= 6.0) {
      signals.push({
        axis: "uric-acid",
        finding: `Uric acid elevated (${latestUa.value} ${latestUa.unit || "mg/dL"})`,
        severity: "moderate",
        rationale: "Uric acid >=6.0 mg/dL in pregnancy correlates with preeclampsia severity.",
      });
      score += 15;
    }
  }

  // ── PROTEINURIA ──────────────────────────────────────────────────────────
  const proteinuriaLabs = chronological(
    input.labReadings.filter((l) => isProteinuria(l.code)),
  );
  let proteinuriaRising = false;
  if (proteinuriaLabs.length) {
    const latestProt = proteinuriaLabs[proteinuriaLabs.length - 1];
    if (latestProt.value >= 30) {
      signals.push({
        axis: "proteinuria",
        finding: `Proteinuria present (${latestProt.value} ${latestProt.unit || "mg/dL"})`,
        severity: "moderate",
        rationale: "Significant proteinuria supports preeclampsia diagnosis.",
        guidelineReference: "NICE NG133",
      });
      score += 20;
    }
    if (proteinuriaLabs.length >= 2) {
      const values = proteinuriaLabs.map((l) => l.value);
      if (trend(values) === "rising") {
        proteinuriaRising = true;
        signals.push({
          axis: "proteinuria",
          finding: "Proteinuria trending upward",
          severity: "mild",
          rationale: "Rising proteinuria across recent samples; monitor preeclampsia evolution.",
        });
        score += 10;
      }
    }
  }

  // ── FASTING GLUCOSE (GDM signal) ─────────────────────────────────────────
  const glucoseLabs = chronological(
    input.labReadings.filter((l) => isFastingGlucose(l.code)),
  );
  if (glucoseLabs.length) {
    const latestGlu = glucoseLabs[glucoseLabs.length - 1];
    if (latestGlu.value >= 92) {
      signals.push({
        axis: "glucose",
        finding: `Fasting glucose at/above IADPSG threshold (${latestGlu.value} mg/dL)`,
        severity: "mild",
        rationale: "IADPSG 2010 fasting glucose threshold for GDM: >=92 mg/dL.",
        guidelineReference: "IADPSG 2010",
      });
      score += 10;
    }
  }

  // ── PATTERN DETECTION: HELLP-evolution ───────────────────────────────────
  // Classic HELLP evolution = rising AST + falling platelets + (rising BP OR rising proteinuria).
  if (astRising && plateletsFalling && (bpRising || proteinuriaRising)) {
    patternFlags.push("HELLP-evolution");
    score += 40;
  }

  // ── GESTATIONAL AGE WEIGHTING ────────────────────────────────────────────
  // Late preterm (>=34w) with severe features is more urgent than early preterm
  // (because delivery becomes the treatment).
  if (input.gestationalAgeWeeks && input.gestationalAgeWeeks >= 32 && score >= 60) {
    score += 10;
  }

  // ── BAND ─────────────────────────────────────────────────────────────────
  let band: UrgencyBand;
  let reviewBy: string;
  if (score >= 80 || patternFlags.includes("HELLP-evolution")) {
    band = "RED";
    reviewBy = "today";
  } else if (score >= 30) {
    band = "YELLOW";
    reviewBy = "within 48 hours";
  } else {
    band = "GREEN";
    reviewBy = "routine schedule";
  }

  return { band, score, signals, patternFlags, reviewBy };
}
