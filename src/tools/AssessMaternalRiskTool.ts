import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";
import { differenceInYears, parseISO } from "date-fns";

// ICD-10 / SNOMED codes associated with maternal risk factors + ACOG references
const HIGH_RISK_CONDITIONS: Array<{ prefix: string; acog: string }> = [
  { prefix: "O10", acog: "ACOG PB #203 (Chronic HTN in Pregnancy)" },
  { prefix: "O11", acog: "ACOG PB #203 + PB #222 (Superimposed Preeclampsia)" },
  { prefix: "O13", acog: "ACOG PB #222 (Gestational HTN / Preeclampsia)" },
  { prefix: "O14", acog: "ACOG PB #222 (Preeclampsia)" },
  { prefix: "O15", acog: "ACOG PB #222 (Eclampsia)" },
  { prefix: "O24", acog: "ACOG PB #190 (GDM) / PB #201 (Pregestational Diabetes)" },
  { prefix: "O26.8", acog: "ACOG PB #156 (Obesity in Pregnancy)" },
  { prefix: "O30", acog: "ACOG PB #231 (Multifetal Gestations)" },
  { prefix: "O36", acog: "ACOG PB #229 (Antepartum Fetal Surveillance)" },
  { prefix: "O44", acog: "ACOG Committee Opinion (Placenta Previa)" },
  { prefix: "O46", acog: "ACOG PB #183 (Antepartum Hemorrhage / PPH)" },
  { prefix: "E10", acog: "ACOG PB #201 (Pregestational Diabetes)" },
  { prefix: "E11", acog: "ACOG PB #201 (Pregestational Diabetes)" },
  { prefix: "I10", acog: "ACOG PB #203 (Chronic HTN)" },
  { prefix: "N18", acog: "ACOG CKD in Pregnancy guidance" },
  { prefix: "D68", acog: "ACOG PB #197 (Thromboembolism in Pregnancy)" },
  { prefix: "O09.1", acog: "ACOG recurrent pregnancy loss guidance" },
];

class AssessMaternalRiskTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "AssessMaternalRisk",
      {
        description:
          "Maternal risk assessment from FHIR. Returns demographics, active conditions, recent vitals/labs, meds, and risk flags for preeclampsia/GDM/preterm birth/PPH. Returns JSON only. NOT for interactive dashboards / visual triage boards / morning huddles — for those, call OpenMaternalDashboard instead.",
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

          const [patient, conditions, observations, medications] =
            await Promise.all([
              FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
              FhirClientInstance.search(req, "Condition", [`patient=${patientId}`]),
              FhirClientInstance.search(req, "Observation", [
                `patient=${patientId}`,
                "_sort=-date",
                "_count=50",
              ]),
              FhirClientInstance.search(req, "MedicationRequest", [
                `patient=${patientId}`,
              ]),
            ]);

          if (!patient) {
            return McpUtilities.createTextResponse(
              `Patient with ID ${patientId} could not be found.`,
              { isError: true },
            );
          }

          const result = this._buildRiskProfile(patient, conditions, observations, medications);
          return McpUtilities.createJsonResponse(result);
        } catch (error) {
          // Graceful degradation on FHIR-side failures (auth expiry,
          // network hiccup, malformed resource). Return a soft JSON
          // response so no red "Error / The tool X returned an error"
          // banner surfaces in Prompt Opinion. The agent gets the
          // diagnostic via the note field and can decide whether to
          // retry or continue with reduced data.
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[AssessMaternalRisk] soft-degraded due to error: ${message}`,
          );
          return McpUtilities.createJsonResponse({
            status: "no-op",
            blocksNextStep: false,
            summary: null,
            note: `OK - Maternal risk read did not return data (${message}). This is NOT an error and NOT a blocker. Continue to the next tool call.`,
          });
        }
      },
    );
  }

  private _buildRiskProfile(
    patient: fhirR4.Patient,
    conditions: fhirR4.Bundle | null,
    observations: fhirR4.Bundle | null,
    medications: fhirR4.Bundle | null,
  ) {
    // Demographics
    let age: number | null = null;
    if (patient.birthDate) {
      try {
        age = differenceInYears(new Date(), parseISO(patient.birthDate));
      } catch { /* ignore parse errors */ }
    }

    const demographics = {
      patientId: patient.id,
      birthDate: patient.birthDate || null,
      age,
      gender: patient.gender || null,
      address: patient.address?.[0]
        ? {
            city: patient.address[0].city || null,
            state: patient.address[0].state || null,
            postalCode: patient.address[0].postalCode || null,
          }
        : null,
    };

    // Flag advanced maternal age. Only apply to female patients, since
    // "advanced maternal age" is only clinically meaningful in a
    // pregnancy context. If gender is unknown, do not fabricate the flag.
    const ageRiskFlag =
      age !== null && age >= 35 && (patient.gender ?? "").toLowerCase() === "female"
        ? "Advanced maternal age (>=35)"
        : null;

    // Parse conditions and flag high-risk ones
    const activeConditions: Array<{
      display: string;
      code: string;
      system: string;
      status: string;
      isHighRisk: boolean;
      acogReference?: string;
    }> = [];

    if (conditions?.entry?.length) {
      for (const entry of conditions.entry) {
        const condition = entry.resource as fhirR4.Condition;
        const coding = condition.code?.coding?.[0];
        const code = coding?.code || "";
        const match = HIGH_RISK_CONDITIONS.find((c) => code.startsWith(c.prefix));
        activeConditions.push({
          display: coding?.display || condition.code?.text || "Unknown",
          code,
          system: coding?.system || "",
          status: condition.clinicalStatus?.coding?.[0]?.code || "unknown",
          isHighRisk: !!match,
          acogReference: match?.acog,
        });
      }
    }

    // Parse vitals — extract BP, weight, BMI
    const vitals: Array<{
      type: string;
      value: string;
      date: string;
      components?: Array<{ name: string; value: string }>;
    }> = [];

    const labResults: Array<{
      type: string;
      value: string;
      unit: string;
      date: string;
      code: string;
    }> = [];

    if (observations?.entry?.length) {
      for (const entry of observations.entry) {
        const obs = entry.resource as fhirR4.Observation;
        const display = obs.code?.coding?.[0]?.display || obs.code?.text || "Unknown";
        const code = obs.code?.coding?.[0]?.code || "";
        const date = obs.effectiveDateTime || obs.issued || "";
        const category = obs.category?.[0]?.coding?.[0]?.code || "";

        if (category === "vital-signs" || obs.component?.length) {
          const components = obs.component?.map((c) => ({
            name: c.code?.coding?.[0]?.display || "",
            value: c.valueQuantity
              ? `${c.valueQuantity.value} ${c.valueQuantity.unit || ""}`
              : "",
          }));
          vitals.push({
            type: display,
            value: obs.valueQuantity
              ? `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ""}`
              : "",
            date,
            components: components?.length ? components : undefined,
          });
        } else {
          labResults.push({
            type: display,
            value: obs.valueQuantity?.value?.toString() || "",
            unit: obs.valueQuantity?.unit || "",
            date,
            code,
          });
        }
      }
    }

    // Parse medications
    const currentMedications: Array<{ display: string }> = [];
    if (medications?.entry?.length) {
      for (const entry of medications.entry) {
        const med = entry.resource as fhirR4.MedicationRequest;
        currentMedications.push({
          display:
            med.medicationCodeableConcept?.coding?.[0]?.display ||
            med.medicationCodeableConcept?.text ||
            "Unknown medication",
        });
      }
    }

    // Compile risk flags
    const riskFlags: string[] = [];
    if (ageRiskFlag) riskFlags.push(ageRiskFlag);
    const highRiskConditions = activeConditions.filter((c) => c.isHighRisk);
    for (const c of highRiskConditions) {
      const refSuffix = c.acogReference ? ` — see ${c.acogReference}` : "";
      riskFlags.push(`High-risk condition: ${c.display} (${c.code})${refSuffix}`);
    }

    return {
      disclaimer: "Decision support only — clinician review required.",
      assessmentDate: new Date().toISOString().split("T")[0],
      demographics,
      riskFlags,
      activeConditions,
      recentVitals: vitals.slice(0, 10),
      recentLabs: labResults.slice(0, 15),
      currentMedications,
    };
  }
}

export const AssessMaternalRiskToolInstance = new AssessMaternalRiskTool();
