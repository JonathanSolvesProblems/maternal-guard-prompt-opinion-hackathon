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

// ICD-10 / SNOMED codes associated with maternal risk factors
const HIGH_RISK_CONDITION_CODES = new Set([
  "O10", "O11", // Pre-existing hypertension
  "O13", "O14", "O15", // Gestational hypertension, preeclampsia, eclampsia
  "O24", // Diabetes in pregnancy
  "O26.8", // Obesity in pregnancy
  "O30", // Multiple gestation
  "O36", // Maternal care for known/suspected fetal problems
  "O44", // Placenta previa
  "O46", // Antepartum hemorrhage
  "E11", // Type 2 diabetes
  "E10", // Type 1 diabetes
  "I10", // Essential hypertension
  "N18", // Chronic kidney disease
  "D68", // Thrombophilia
  "O09.1", // Supervision of pregnancy with history of ectopic pregnancy
]);

class AssessMaternalRiskTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "AssessMaternalRisk",
      {
        description:
          "Retrieves and structures a pregnant patient's clinical data from FHIR (demographics, conditions, vitals, labs, medications) for maternal risk assessment. Returns organized clinical data with flagged risk factors for preeclampsia, gestational diabetes, preterm birth, and postpartum hemorrhage. The platform AI model uses this structured data to perform clinical reasoning.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe(
              "The FHIR Patient resource ID. Optional if patient context is provided via SHARP headers.",
            )
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
          const message = error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error retrieving maternal risk data: ${message}`,
            { isError: true },
          );
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

    // Flag advanced maternal age
    const ageRiskFlag = age !== null && age >= 35 ? "Advanced maternal age (>=35)" : null;

    // Parse conditions and flag high-risk ones
    const activeConditions: Array<{
      display: string;
      code: string;
      system: string;
      status: string;
      isHighRisk: boolean;
    }> = [];

    if (conditions?.entry?.length) {
      for (const entry of conditions.entry) {
        const condition = entry.resource as fhirR4.Condition;
        const coding = condition.code?.coding?.[0];
        const code = coding?.code || "";
        const isHighRisk = Array.from(HIGH_RISK_CONDITION_CODES).some((hrc) =>
          code.startsWith(hrc),
        );
        activeConditions.push({
          display: coding?.display || condition.code?.text || "Unknown",
          code,
          system: coding?.system || "",
          status: condition.clinicalStatus?.coding?.[0]?.code || "unknown",
          isHighRisk,
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
      riskFlags.push(`High-risk condition: ${c.display} (${c.code})`);
    }

    return {
      disclaimer:
        "This is structured clinical data for decision support. All findings must be reviewed by a qualified healthcare provider.",
      assessmentDate: new Date().toISOString().split("T")[0],
      demographics,
      riskFlags,
      activeConditions,
      recentVitals: vitals.slice(0, 10),
      recentLabs: labResults.slice(0, 15),
      currentMedications,
      riskCategoriesToAssess: [
        "Preeclampsia — look for hypertension, proteinuria, elevated liver enzymes, low platelets",
        "Gestational Diabetes — look for elevated glucose, BMI, family history, prior GDM",
        "Preterm Birth — look for prior preterm birth, cervical insufficiency, multiple gestation, infections",
        "Postpartum Hemorrhage — look for prior PPH, placenta previa, grand multiparity, prolonged labor",
      ],
    };
  }
}

export const AssessMaternalRiskToolInstance = new AssessMaternalRiskTool();
