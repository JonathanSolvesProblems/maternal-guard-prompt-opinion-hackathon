import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";

// Common LOINC codes for maternal monitoring. Canonical keys are
// lowercase-hyphenated (kept for backward compat with the tool
// description). Case-insensitive matching + alias handling lives in
// resolveLabTypeCode() below so the tool accepts the wide range of
// natural phrasings the model actually emits.
const LOINC_CODES: Record<string, { code: string; display: string }> = {
  "blood-pressure": { code: "85354-9", display: "Blood Pressure Panel" },
  "systolic-bp": { code: "8480-6", display: "Systolic Blood Pressure" },
  "diastolic-bp": { code: "8462-4", display: "Diastolic Blood Pressure" },
  glucose: { code: "2345-7", display: "Glucose [Mass/volume] in Serum or Plasma" },
  "fasting-glucose": { code: "1558-6", display: "Fasting Glucose" },
  hemoglobin: { code: "718-7", display: "Hemoglobin [Mass/volume] in Blood" },
  hematocrit: { code: "4544-3", display: "Hematocrit" },
  platelets: { code: "777-3", display: "Platelets [#/volume] in Blood" },
  proteinuria: { code: "2888-6", display: "Protein [Mass/volume] in Urine" },
  "uric-acid": { code: "3084-1", display: "Urate [Mass/volume] in Serum or Plasma" },
  ast: { code: "1920-8", display: "AST [Enzymatic activity/volume] in Serum or Plasma" },
  alt: { code: "1742-6", display: "ALT [Enzymatic activity/volume] in Serum or Plasma" },
  weight: { code: "29463-7", display: "Body Weight" },
};

// Every natural phrasing the model tends to emit, mapped to the
// canonical LOINC_CODES key. Values here MUST exist as keys in
// LOINC_CODES. Case is normalised before lookup.
const LAB_TYPE_ALIASES: Record<string, string> = {
  // blood pressure
  "blood-pressure": "blood-pressure",
  "bloodpressure": "blood-pressure",
  "bp": "blood-pressure",
  "blood-pressure-panel": "blood-pressure",
  // systolic / diastolic
  "systolic": "systolic-bp",
  "systolic-bp": "systolic-bp",
  "systolic-blood-pressure": "systolic-bp",
  "sbp": "systolic-bp",
  "diastolic": "diastolic-bp",
  "diastolic-bp": "diastolic-bp",
  "diastolic-blood-pressure": "diastolic-bp",
  "dbp": "diastolic-bp",
  // glucose
  "glucose": "glucose",
  "blood-glucose": "glucose",
  "serum-glucose": "glucose",
  "fasting-glucose": "fasting-glucose",
  "fasting-blood-glucose": "fasting-glucose",
  "fasting-blood-sugar": "fasting-glucose",
  "fbs": "fasting-glucose",
  // hgb / hct
  "hemoglobin": "hemoglobin",
  "haemoglobin": "hemoglobin",
  "hgb": "hemoglobin",
  "hb": "hemoglobin",
  "hematocrit": "hematocrit",
  "haematocrit": "hematocrit",
  "hct": "hematocrit",
  // platelets
  "platelets": "platelets",
  "platelet": "platelets",
  "platelet-count": "platelets",
  "plt": "platelets",
  // protein / proteinuria
  "protein": "proteinuria",
  "proteinuria": "proteinuria",
  "urine-protein": "proteinuria",
  "urinary-protein": "proteinuria",
  "spot-protein": "proteinuria",
  // uric acid
  "uric-acid": "uric-acid",
  "urate": "uric-acid",
  // liver enzymes
  "ast": "ast",
  "aspartate-aminotransferase": "ast",
  "sgot": "ast",
  "alt": "alt",
  "alanine-aminotransferase": "alt",
  "sgpt": "alt",
  // weight
  "weight": "weight",
  "body-weight": "weight",
  "maternal-weight": "weight",
};

/**
 * Map an arbitrary lab-type string from the model to a canonical LOINC
 * code. Case-insensitive; underscores / spaces normalise to hyphens;
 * common clinical aliases are honoured (see LAB_TYPE_ALIASES).
 * Returns null when nothing matches.
 */
function resolveLabTypeCode(raw: string): string | null {
  const norm = raw.toLowerCase().trim().replace(/[\s_]+/g, "-");
  const canonical = LAB_TYPE_ALIASES[norm];
  if (canonical && LOINC_CODES[canonical]) {
    return LOINC_CODES[canonical].code;
  }
  if (LOINC_CODES[norm]) {
    return LOINC_CODES[norm].code;
  }
  return null;
}

// Pregnancy reference ranges for key labs
const PREGNANCY_REFERENCE_RANGES: Record<string, string> = {
  "85354-9": "Systolic <140 mmHg, Diastolic <90 mmHg (hypertension threshold in pregnancy)",
  "8480-6": "<140 mmHg (>=140 suggests gestational hypertension; >=160 is severe)",
  "8462-4": "<90 mmHg (>=90 suggests gestational hypertension; >=110 is severe)",
  "2345-7": "70-100 mg/dL fasting; <140 mg/dL 1-hr post-meal",
  "1558-6": "<92 mg/dL (>=92 suggests GDM per IADPSG criteria)",
  "718-7": "11.0-14.0 g/dL (physiologic anemia of pregnancy lowers normal range)",
  "4544-3": "33-38% (lower in pregnancy due to plasma volume expansion)",
  "777-3": "150,000-400,000/uL (<100,000 concerning for HELLP syndrome)",
  "2888-6": "<300 mg/24hr or <30 mg/dL spot (>=300 mg significant proteinuria)",
  "3084-1": "<6.0 mg/dL (elevated levels associated with preeclampsia)",
  "1920-8": "10-40 U/L (elevation may indicate HELLP syndrome)",
  "1742-6": "7-35 U/L (elevation may indicate HELLP syndrome)",
  "29463-7": "Varies by pre-pregnancy BMI; expected gain 25-35 lbs for normal BMI",
};

class InterpretLabTrendsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "InterpretLabTrends",
      {
        description:
          "Longitudinal lab/vital trends from FHIR with pregnancy reference ranges. Accepts labTypes as an array of strings OR a single comma-separated string (both forms coerced server-side); matching is case-insensitive and honours common aliases (Platelets/Platelet/PLT, Protein/Proteinuria/Urine Protein, BP/Blood Pressure, Fasting Glucose/FBS, Hgb/Hemoglobin, HCT/Hematocrit, AST/SGOT, ALT/SGPT, Uric Acid/Urate, Weight). Canonical types: blood-pressure, systolic-bp, diastolic-bp, glucose, fasting-glucose, hemoglobin, hematocrit, platelets, proteinuria, uric-acid, ast, alt, weight. Omit labTypes to fetch all. gestationalAgeWeeks accepts a number or a numeric string. Returns JSON only. NOT for interactive dashboards / visual triage boards — for those, call OpenMaternalDashboard instead.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
          labTypes: z
            .union([z.array(z.string()), z.string()])
            .nullable()
            .describe(
              "Lab/vital types to fetch. Prefer an array of strings, e.g. [\"Platelets\", \"Protein\"]. A single comma-separated string is also accepted (\"Platelets,Protein\"). Omit for all.",
            )
            .optional(),
          gestationalAgeWeeks: z
            .union([z.number(), z.string()])
            .nullable()
            .describe(
              "Gestational age in weeks. Prefer a number (e.g. 28). A numeric string (\"28\") is also accepted.",
            )
            .optional(),
        },
      },
      async ({ patientId, labTypes, gestationalAgeWeeks }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "No patient ID provided and no patient context found in SHARP headers.",
            );
          }

          // The Prompt Opinion agent occasionally serialises array/number
          // arguments as strings ("Platelets,Protein" instead of
          // ["Platelets","Protein"]; "28" instead of 28). Zod would
          // previously -32602 the whole call at validation time, before
          // this handler's soft-degrade catch could fire, and Prompt
          // Opinion painted the row red. Schema now accepts both shapes;
          // coerce here so the rest of the handler always sees a
          // string[] and number|undefined.
          const labTypesArray: string[] =
            typeof labTypes === "string"
              ? labTypes.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
              : Array.isArray(labTypes)
                ? labTypes
                : [];

          const gestationalAgeWeeksNum: number | undefined =
            typeof gestationalAgeWeeks === "number"
              ? gestationalAgeWeeks
              : typeof gestationalAgeWeeks === "string" &&
                  gestationalAgeWeeks.trim() !== "" &&
                  !isNaN(Number(gestationalAgeWeeks))
                ? Number(gestationalAgeWeeks)
                : undefined;

          // Case-insensitive + alias-aware lookup. Previous strict
          // literal match caused the model to loop on "Platelets" vs
          // "platelets" and Prompt Opinion tinted the tool row red on
          // repeated no-match returns. Log the input and the resolved
          // codes so we can see if the model is guessing shapes we
          // still don't cover.
          const resolvedCodes = labTypesArray.length
            ? Array.from(
                new Set(
                  labTypesArray
                    .map((lt) => resolveLabTypeCode(lt))
                    .filter((c): c is string => c !== null),
                ),
              )
            : Object.values(LOINC_CODES).map((v) => v.code);
          if (labTypesArray.length) {
            const unresolved = labTypesArray.filter(
              (lt) => resolveLabTypeCode(lt) === null,
            );
            if (unresolved.length) {
              console.warn(
                `[InterpretLabTrends] unresolved labTypes (kept resolved ones and continued): ${JSON.stringify(unresolved)}`,
              );
            }
          }
          const codesToQuery = resolvedCodes;

          if (codesToQuery.length === 0) {
            // Every requested lab type was unrecognisable even after
            // alias + case normalisation. Return a soft response with
            // both the canonical vocabulary AND common aliases. Note
            // wording deliberately signals "not a blocker, continue"
            // because the agent's Priority-1 chart-writeback flow
            // needs to move on to ProposeMaternalAction regardless of
            // whether trend data landed.
            return McpUtilities.createJsonResponse({
              status: "no-op",
              blocksNextStep: false,
              patientId,
              trends: [],
              note:
                "OK - No lab data returned because none of the requested labTypes matched a known LOINC code. This is NOT an error and NOT a blocker. If you were on the way to ProposeMaternalAction, continue there now with the recommendation you already have; the lab-trend context is optional. To fix future calls: canonical types are " +
                Object.keys(LOINC_CODES).join(", ") +
                ", or use common aliases (Platelets/PLT, Protein/Proteinuria/Urine Protein, BP/Blood Pressure, Fasting Glucose/FBS, Hgb/Hemoglobin, HCT/Hematocrit, AST/SGOT, ALT/SGPT, Uric Acid/Urate, Weight), or omit labTypes entirely to fetch all supported labs.",
            });
          }

          const observations = await FhirClientInstance.search(
            req,
            "Observation",
            [
              `patient=${patientId}`,
              `code=${codesToQuery.join(",")}`,
              "_sort=date",
              "_count=200",
            ],
          );

          if (!observations?.entry?.length) {
            return McpUtilities.createJsonResponse({
              status: "no-op",
              blocksNextStep: false,
              patientId,
              gestationalAgeWeeks: gestationalAgeWeeksNum ?? null,
              requestedLabTypes: codesToQuery,
              trends: [],
              note: "OK - No matching Observations on this patient for the requested lab types. This is NOT an error and NOT a blocker. Continue to the next tool call (e.g. ProposeMaternalAction) if you were on that path.",
            });
          }

          const result = this._buildTrendData(observations, gestationalAgeWeeksNum);
          return McpUtilities.createJsonResponse(result);
        } catch (error) {
          // Graceful degradation: any FHIR-side failure (auth expiry,
          // network hiccup, resource missing, malformed search
          // parameters) is returned as a soft "no data on this axis"
          // response with an explanatory note instead of an isError:
          // true payload. Rationale: an isError response on a data tool
          // surfaces a red "Error / The tool X returned an error" banner
          // in Prompt Opinion that spooks the clinician even though the
          // agent almost always recovers on the next tool call. The
          // agent still receives the diagnostic message via the note
          // field and can decide whether to retry or skip this axis.
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[InterpretLabTrends] soft-degraded due to error: ${message}`,
          );
          return McpUtilities.createJsonResponse({
            status: "no-op",
            blocksNextStep: false,
            patientId,
            trends: [],
            note: `OK - Lab trend read did not return data (${message}). This is NOT an error and NOT a blocker for downstream calls. If you were on the way to ProposeMaternalAction, continue there now.`,
          });
        }
      },
    );
  }

  private _buildTrendData(
    observations: fhirR4.Bundle,
    gestationalAgeWeeks?: number,
  ) {
    // Group observations by LOINC code
    const grouped = new Map<
      string,
      {
        display: string;
        readings: Array<{
          date: string;
          value: number | null;
          unit: string;
          components?: Array<{ name: string; value: number | null; unit: string }>;
        }>;
      }
    >();

    for (const entry of observations.entry || []) {
      const obs = entry.resource as fhirR4.Observation;
      const code = obs.code?.coding?.[0]?.code || "unknown";
      const display = obs.code?.coding?.[0]?.display || obs.code?.text || "Unknown";
      const date = obs.effectiveDateTime || obs.issued || "";

      if (!grouped.has(code)) {
        grouped.set(code, { display, readings: [] });
      }

      const reading: {
        date: string;
        value: number | null;
        unit: string;
        components?: Array<{ name: string; value: number | null; unit: string }>;
      } = {
        date,
        value: obs.valueQuantity?.value ?? null,
        unit: obs.valueQuantity?.unit || "",
      };

      if (obs.component?.length) {
        reading.components = obs.component.map((c) => ({
          name: c.code?.coding?.[0]?.display || "",
          value: c.valueQuantity?.value ?? null,
          unit: c.valueQuantity?.unit || "",
        }));
      }

      grouped.get(code)!.readings.push(reading);
    }

    // Build trend summaries with reference ranges
    const trends = Array.from(grouped.entries()).map(([code, data]) => {
      const numericValues = data.readings
        .map((r) => r.value)
        .filter((v): v is number => v !== null);

      let trend: { min: number; max: number; mean: number; count: number } | null = null;
      if (numericValues.length > 0) {
        trend = {
          min: Math.min(...numericValues),
          max: Math.max(...numericValues),
          mean: Math.round((numericValues.reduce((a, b) => a + b, 0) / numericValues.length) * 100) / 100,
          count: numericValues.length,
        };
      }

      return {
        loincCode: code,
        display: data.display,
        pregnancyReferenceRange: PREGNANCY_REFERENCE_RANGES[code] || "Not available",
        statistics: trend,
        readings: data.readings,
      };
    });

    return {
      disclaimer: "Decision support only — clinician review required.",
      analysisDate: new Date().toISOString().split("T")[0],
      gestationalAgeWeeks: gestationalAgeWeeks || null,
      trends,
    };
  }
}

export const InterpretLabTrendsToolInstance = new InterpretLabTrendsTool();
