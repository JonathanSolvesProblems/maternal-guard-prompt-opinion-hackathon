import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";

class ScreenSocialDeterminantsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "ScreenSocialDeterminants",
      {
        description:
          "SDOH screening from FHIR. Returns demographics, insurance, language, social history observations, and flagged barriers (no insurance, non-English primary language, missing contact info, absent screening). Returns JSON only. NOT for interactive dashboards — for those, call OpenMaternalDashboard instead.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
        },
      },
      async ({ patientId }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "No patient ID provided and no patient context found in SHARP headers.",
            );
          }

          const [patient, socialHistory, coverage] = await Promise.all([
            FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
            FhirClientInstance.search(req, "Observation", [
              `patient=${patientId}`,
              `category=social-history`,
            ]),
            FhirClientInstance.search(req, "Coverage", [
              `patient=${patientId}`,
              `status=active`,
            ]),
          ]);

          if (!patient) {
            return McpUtilities.createTextResponse(
              `Patient with ID ${patientId} could not be found.`,
              { isError: true },
            );
          }

          const result = this._buildSdohProfile(patient, socialHistory, coverage);
          return McpUtilities.createJsonResponse(result);
        } catch (error) {
          // Graceful degradation on FHIR-side failures. Soft JSON so no
          // red banner surfaces in Prompt Opinion. See InterpretLabTrends
          // catch block for the full rationale.
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[ScreenSocialDeterminants] soft-degraded due to error: ${message}`,
          );
          return McpUtilities.createJsonResponse({
            sdohProfile: null,
            note: `SDOH data could not be retrieved (${message}). Skip this axis and continue the assessment.`,
          });
        }
      },
    );
  }

  private _buildSdohProfile(
    patient: fhirR4.Patient,
    socialHistory: fhirR4.Bundle | null,
    coverage: fhirR4.Bundle | null,
  ) {
    // Identify potential red flags
    const potentialBarriers: string[] = [];

    // Address analysis
    const address = patient.address?.[0];
    const hasAddress = !!address;
    if (!hasAddress) {
      potentialBarriers.push("No address on file — possible housing instability");
    }

    // Contact info
    const hasPhone = patient.telecom?.some((t) => t.system === "phone") ?? false;
    const hasEmail = patient.telecom?.some((t) => t.system === "email") ?? false;
    if (!hasPhone && !hasEmail) {
      potentialBarriers.push("No contact information on file — may be difficult to reach for appointments");
    }

    // Language barriers
    const languages = patient.communication?.map((comm) => ({
      language: comm.language?.coding?.[0]?.display || comm.language?.text || "Unknown",
      preferred: comm.preferred ?? false,
    })) || [];
    const hasNonEnglishPrimary = languages.some(
      (l) => l.preferred && !l.language.toLowerCase().includes("english"),
    );
    if (hasNonEnglishPrimary) {
      potentialBarriers.push(`Primary language is not English — interpreter services may be needed`);
    }

    // Insurance
    const coverageEntries: Array<{ type: string; status: string }> = [];
    if (coverage?.entry?.length) {
      for (const entry of coverage.entry) {
        const cov = entry.resource as fhirR4.Coverage;
        coverageEntries.push({
          type: cov.type?.coding?.[0]?.display || cov.type?.text || "Unknown",
          status: cov.status || "unknown",
        });
      }
    } else {
      potentialBarriers.push("No active insurance coverage found — significant barrier to prenatal care access");
    }

    // Social history observations
    const socialFactors: Array<{
      type: string;
      value: string;
      code: string;
      date: string;
    }> = [];
    if (socialHistory?.entry?.length) {
      for (const entry of socialHistory.entry) {
        const obs = entry.resource as fhirR4.Observation;
        let value = "";
        if (obs.valueCodeableConcept) {
          value = obs.valueCodeableConcept.coding?.[0]?.display || obs.valueCodeableConcept.text || "";
        } else if (obs.valueQuantity) {
          value = `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ""}`;
        } else if (obs.valueString) {
          value = obs.valueString;
        }
        socialFactors.push({
          type: obs.code?.coding?.[0]?.display || obs.code?.text || "Unknown",
          value,
          code: obs.code?.coding?.[0]?.code || "",
          date: obs.effectiveDateTime || obs.issued || "",
        });
      }
    } else {
      potentialBarriers.push("No social history observations recorded — formal SDOH screening may not have been conducted");
    }

    return {
      disclaimer: "Decision support only — social work consult recommended for identified barriers.",
      screeningDate: new Date().toISOString().split("T")[0],
      patientId: patient.id,
      demographics: {
        birthDate: patient.birthDate || null,
        gender: patient.gender || null,
        maritalStatus:
          patient.maritalStatus?.coding?.[0]?.display ||
          patient.maritalStatus?.text ||
          null,
        address: hasAddress
          ? {
              line: address!.line?.join(" ") || null,
              city: address!.city || null,
              state: address!.state || null,
              postalCode: address!.postalCode || null,
            }
          : null,
        hasPhone,
        hasEmail,
        languages,
      },
      insuranceCoverage: coverageEntries,
      socialHistoryObservations: socialFactors,
      potentialBarriers,
    };
  }
}

export const ScreenSocialDeterminantsToolInstance = new ScreenSocialDeterminantsTool();
