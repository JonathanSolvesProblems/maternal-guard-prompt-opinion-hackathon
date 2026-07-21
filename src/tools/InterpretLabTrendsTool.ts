import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";

// Common LOINC codes for maternal monitoring
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
          "Longitudinal lab/vital trends from FHIR with pregnancy reference ranges. Supports: blood-pressure, glucose, fasting-glucose, hemoglobin, hematocrit, platelets, proteinuria, uric-acid, ast, alt, weight. Returns JSON only. NOT for interactive dashboards / visual triage boards — for those, call OpenMaternalDashboard instead.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
          labTypes: z
            .array(z.string())
            .nullable()
            .describe("Lab/vital types to fetch. Omit for all.")
            .optional(),
          gestationalAgeWeeks: z
            .number()
            .nullable()
            .describe("Gestational age in weeks.")
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

          const codesToQuery = labTypes?.length
            ? labTypes
                .filter((lt) => LOINC_CODES[lt])
                .map((lt) => LOINC_CODES[lt]!.code)
            : Object.values(LOINC_CODES).map((v) => v.code);

          if (codesToQuery.length === 0) {
            // All requested lab types were unrecognized. Explain to the model
            // rather than issuing a malformed `code=` FHIR search.
            return McpUtilities.createJsonResponse({
              patientId,
              trends: [],
              note: "None of the requested labTypes are recognized. Choose from: " +
                Object.keys(LOINC_CODES).join(", "),
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
            // Empty result is NOT an error. Report it as a normal response so
            // the model treats "no data yet" as a data state, not a tool
            // failure.
            return McpUtilities.createJsonResponse({
              patientId,
              gestationalAgeWeeks: gestationalAgeWeeks ?? null,
              requestedLabTypes: codesToQuery,
              trends: [],
              note: "No matching observations found for the requested lab types on this patient.",
            });
          }

          const result = this._buildTrendData(observations, gestationalAgeWeeks ?? undefined);
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
            patientId,
            trends: [],
            note: `Lab trend data could not be retrieved for this patient (${message}). Skip this axis and continue the assessment with the data you already have.`,
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
