// Pregnancy-context helpers shared by every tool that decides whether
// maternal-health decision support is applicable to a given FHIR Patient.
//
// The classifier itself (urgency-classifier.ts) is intentionally pure and
// depends only on structured vitals/labs — it has no way to know if the
// patient it just scored is even pregnant. These helpers give the tool
// layer a single place to check that before running the classifier or
// emitting a RED/YELLOW/GREEN band.

import { fhirR4 } from "@smile-cdr/fhirts";

/**
 * Resolve current gestational age (weeks) from a Patient's pregnancy
 * Conditions.
 *
 * Priority:
 *   1. ICD-10 Z3A.XX ("Weeks of gestation, XX weeks") — encodes the week
 *      directly on the Condition.code, no math required. Preferred because
 *      it is authored per-encounter with the actual current week.
 *   2. ICD-10 Z34.* ("Encounter for supervision of normal pregnancy") —
 *      onsetDateTime is used as the effective LMP and weeks-since is
 *      computed. Less accurate: Z34 is typically re-coded at each visit,
 *      so onsetDateTime may not be LMP; treat as fallback only.
 *
 * Returns null if no pregnancy Condition is present.
 */
export function gestationalAgeFromConditions(
  bundle: fhirR4.Bundle | undefined,
): number | null {
  if (!bundle?.entry?.length) return null;

  // Pass 1: Z3A.XX carries the week directly. The last two chars of the
  // code encode the week (e.g. Z3A.32 = 32 weeks). Some encoders use
  // "Z3A32" with no dot; handle both.
  for (const e of bundle.entry) {
    const c = e.resource as fhirR4.Condition | undefined;
    for (const coding of c?.code?.coding ?? []) {
      const codeRaw = (coding.code ?? "").toUpperCase();
      if (!codeRaw.startsWith("Z3A")) continue;
      const weeksStr = codeRaw.replace(/^Z3A\.?/, "");
      const weeks = parseInt(weeksStr, 10);
      if (!Number.isNaN(weeks) && weeks >= 1 && weeks <= 45) {
        return weeks;
      }
    }
  }

  // Pass 2: Z34 onset as effective LMP.
  for (const e of bundle.entry) {
    const c = e.resource as fhirR4.Condition | undefined;
    const hasZ34 = c?.code?.coding?.some((cc) =>
      (cc.code ?? "").toUpperCase().startsWith("Z34"),
    );
    if (!hasZ34) continue;
    const onset = c?.onsetDateTime;
    if (!onset) continue;
    const start = new Date(onset).getTime();
    if (Number.isNaN(start)) continue;
    const weeks = Math.floor((Date.now() - start) / (7 * 24 * 3600 * 1000));
    if (weeks >= 0 && weeks <= 45) return weeks;
  }

  return null;
}

/**
 * Is this patient in scope for maternal-health decision support?
 *
 * Requires:
 *   - Patient.gender === "female" (case-insensitive). Absent or "unknown"
 *     is treated as OUT of scope so we don't fabricate an "advanced
 *     maternal age" or HELLP band on a patient whose sex is unrecorded.
 *   - At least one active pregnancy Condition (Z34.* or Z3A.*) with
 *     clinicalStatus ∈ {active, recurrence, relapse}. A resolved or
 *     inactive Z34/Z3A means the pregnancy has ended (delivery,
 *     miscarriage, termination) and the tools should not run.
 *
 * Returns a discriminated result so the tool layer can distinguish
 * "wrong gender", "no pregnancy Condition", and "pregnancy resolved"
 * for a helpful in-UI explanation instead of silently skipping.
 */
export type PregnancyContext =
  | { applicable: true; gestationalAgeWeeks: number | null }
  | { applicable: false; reason: "non-female" | "no-pregnancy-condition" | "pregnancy-resolved" };

export function pregnancyContext(
  patient: fhirR4.Patient | null | undefined,
  conditions: fhirR4.Bundle | undefined,
): PregnancyContext {
  const gender = (patient?.gender ?? "").toLowerCase();
  if (gender !== "female") {
    return { applicable: false, reason: "non-female" };
  }

  const pregnancyConditions =
    (conditions?.entry ?? [])
      .map((e) => e.resource as fhirR4.Condition | undefined)
      .filter((c): c is fhirR4.Condition =>
        !!c?.code?.coding?.some((cc) => {
          const code = (cc.code ?? "").toUpperCase();
          return code.startsWith("Z34") || code.startsWith("Z3A");
        }),
      );

  if (!pregnancyConditions.length) {
    return { applicable: false, reason: "no-pregnancy-condition" };
  }

  const anyActive = pregnancyConditions.some((c) => {
    const status = c.clinicalStatus?.coding?.[0]?.code ?? "active";
    return ["active", "recurrence", "relapse"].includes(status);
  });
  if (!anyActive) {
    return { applicable: false, reason: "pregnancy-resolved" };
  }

  return {
    applicable: true,
    gestationalAgeWeeks: gestationalAgeFromConditions(conditions),
  };
}
