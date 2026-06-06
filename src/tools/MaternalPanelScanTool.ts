import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";
import {
  classifyUrgency,
  VitalReading,
  LabReading,
  UrgencyAssessment,
} from "../clinical/urgency-classifier";

// Env-gated like LoopGuard's cohort_scan tool.
// When MATERNALGUARD_ENABLE_PANEL_SCAN is not "true", this tool is not registered.
//
// Operates on a BUNDLED COHORT (patient IDs configured below). It does not
// enumerate a live workspace. Live workspace enumeration is a future
// Prompt Opinion platform feature.
const BUNDLED_PATIENT_IDS_ENV = "MATERNALGUARD_BUNDLED_PATIENT_IDS";
const ENABLE_FLAG_ENV = "MATERNALGUARD_ENABLE_PANEL_SCAN";

function getBundledPatientIds(): string[] {
  const raw = process.env[BUNDLED_PATIENT_IDS_ENV];
  if (!raw) {
    // Fallback to a known synthetic-cohort patient set.
    return [
      "maria-santos-uuid", // HELLP-evolving (placeholder; replace with real UUID at deploy time)
      "lin-zhang-uuid",     // stable normal pregnancy
      "amara-okonkwo-uuid", // mild preeclampsia, stable
      "rachel-fisher-uuid", // mild GDM, no preeclampsia
    ];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

class MaternalPanelScanTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    if (process.env[ENABLE_FLAG_ENV] !== "true") {
      // Tool disabled — do not register.
      return;
    }

    server.registerTool(
      "MaternalPanelScan",
      {
        description:
          "Scans a bundled cohort of pregnant patients, classifies maternal urgency (RED / YELLOW / GREEN) using deterministic rules from vitals + labs, and returns a ranked triage queue. Use for morning huddle and panel triage. Does NOT enumerate a live workspace — operates on the bundled patient list configured via MATERNALGUARD_BUNDLED_PATIENT_IDS.",
        inputSchema: {
          band: z
            .enum(["RED", "YELLOW", "GREEN", "ALL"])
            .nullable()
            .describe("Filter results to only this urgency band. Default: ALL.")
            .optional(),
          maxResults: z
            .union([z.number(), z.string()])
            .nullable()
            .describe("Cap the number of patients returned. Pass as a number, not a string. Default: 25.")
            .optional(),
        },
      },
      async ({ band, maxResults }) => {
        try {
          const bundledIds = getBundledPatientIds();
          if (!bundledIds.length) {
            return McpUtilities.createTextResponse(
              "No bundled patients configured. Set MATERNALGUARD_BUNDLED_PATIENT_IDS env var.",
              { isError: true },
            );
          }

          const results: Array<{
            patientId: string;
            patientDisplay: string;
            urgency: UrgencyAssessment;
            scannedAt: string;
            reviewRequired: true;
          }> = [];

          for (const pid of bundledIds) {
            try {
              const [patient, observations] = await Promise.all([
                FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${pid}`),
                FhirClientInstance.search(req, "Observation", [
                  `patient=${pid}`,
                  "_sort=-date",
                  "_count=100",
                ]),
              ]);

              if (!patient) continue;

              const bpReadings: VitalReading[] = [];
              const labReadings: LabReading[] = [];

              if (observations?.entry?.length) {
                for (const e of observations.entry) {
                  const obs = e.resource as fhirR4.Observation;
                  const code = obs.code?.coding?.[0]?.code || "";
                  const display = obs.code?.coding?.[0]?.display || "";
                  const date = obs.effectiveDateTime || obs.issued || "";

                  if (obs.component?.length && code === "85354-9") {
                    const sys = obs.component.find(
                      (c) => c.code?.coding?.[0]?.code === "8480-6",
                    )?.valueQuantity?.value;
                    const dia = obs.component.find(
                      (c) => c.code?.coding?.[0]?.code === "8462-4",
                    )?.valueQuantity?.value;
                    bpReadings.push({
                      date,
                      systolicMmHg: typeof sys === "number" ? sys : null,
                      diastolicMmHg: typeof dia === "number" ? dia : null,
                    });
                  } else if (typeof obs.valueQuantity?.value === "number") {
                    labReadings.push({
                      code,
                      display,
                      value: obs.valueQuantity.value,
                      unit: obs.valueQuantity.unit,
                      date,
                    });
                  }
                }
              }

              const gestationalAgeWeeks = estimateGestationalAgeFromPatient(patient);

              const urgency = classifyUrgency({
                gestationalAgeWeeks,
                bpReadings,
                labReadings,
              });

              const nameParts =
                patient.name?.[0]?.family && patient.name?.[0]?.given
                  ? `${patient.name[0].family}, ${patient.name[0].given.join(" ")}`
                  : patient.name?.[0]?.text || pid;

              results.push({
                patientId: pid,
                patientDisplay: nameParts,
                urgency,
                scannedAt: new Date().toISOString(),
                reviewRequired: true,
              });
            } catch (perPatientError) {
              console.error(
                `[MaternalPanelScan] error scanning patient ${pid}:`,
                perPatientError,
              );
              // Continue scanning other patients in the cohort.
            }
          }

          let filtered = results;
          if (band && band !== "ALL") {
            filtered = results.filter((r) => r.urgency.band === band);
          }

          filtered.sort((a, b) => b.urgency.score - a.urgency.score);

          // Coerce stringified numbers (some LLMs send "25" instead of 25).
          const capNum =
            typeof maxResults === "number"
              ? maxResults
              : typeof maxResults === "string" && maxResults.trim() !== ""
                ? Number(maxResults)
                : 25;
          const cap = !isNaN(capNum) && capNum > 0 ? capNum : 25;
          const ranked = filtered.slice(0, cap);

          return McpUtilities.createJsonResponse({
            disclaimer:
              "Decision support only. Clinician review required before any action.",
            scannedAt: new Date().toISOString(),
            cohortSize: bundledIds.length,
            cohortSource:
              "bundled patient list (live workspace enumeration is a future platform feature)",
            filterBand: band ?? "ALL",
            returnedCount: ranked.length,
            triageQueue: ranked,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error during panel scan: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }
}

function estimateGestationalAgeFromPatient(_patient: fhirR4.Patient): number | null {
  // Best-effort placeholder. The full version would query the patient's
  // pregnancy Condition (Z34.XX) onsetDateTime and compute weeks from there.
  // For the bundled-cohort demo, individual patient builders embed the
  // gestational age via Condition.onsetDateTime which the agent reads
  // through other tools (GenerateCarePlan, InterpretLabTrends).
  return null;
}

export const MaternalPanelScanToolInstance = new MaternalPanelScanTool();
