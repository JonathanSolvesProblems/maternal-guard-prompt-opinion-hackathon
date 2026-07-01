import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";

class GenerateCarePlanTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GenerateCarePlan",
      {
        description:
          "Care plan context from FHIR: conditions, allergies, meds, existing care plans, and ACOG-aligned screening recommendations for the gestational age and risk level. Returns JSON only. NOT for interactive dashboards or visual triage boards — for those, call OpenMaternalDashboard instead.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
          riskLevel: z
            .string()
            .nullable()
            .describe('One of: "low", "moderate", "high", "critical". Defaults to "moderate".')
            .optional(),
          gestationalAgeWeeks: z
            .number()
            .nullable()
            .describe("Gestational age in weeks.")
            .optional(),
        },
      },
      async ({ patientId, riskLevel, gestationalAgeWeeks }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "No patient ID provided and no patient context found in SHARP headers.",
            );
          }

          const [patient, conditions, allergies, medications, existingCarePlans] =
            await Promise.all([
              FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
              FhirClientInstance.search(req, "Condition", [`patient=${patientId}`]),
              FhirClientInstance.search(req, "AllergyIntolerance", [`patient=${patientId}`]),
              FhirClientInstance.search(req, "MedicationRequest", [`patient=${patientId}`]),
              FhirClientInstance.search(req, "CarePlan", [
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

          const result = this._buildCarePlanContext(
            patient,
            conditions,
            allergies,
            medications,
            existingCarePlans,
            riskLevel || "moderate",
            gestationalAgeWeeks ?? undefined,
          );
          return McpUtilities.createJsonResponse(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error retrieving care plan data: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _buildCarePlanContext(
    patient: fhirR4.Patient,
    conditions: fhirR4.Bundle | null,
    allergies: fhirR4.Bundle | null,
    medications: fhirR4.Bundle | null,
    existingCarePlans: fhirR4.Bundle | null,
    riskLevel: string,
    gestationalAgeWeeks?: number,
  ) {
    const activeConditions = (conditions?.entry || []).map((entry) => {
      const condition = entry.resource as fhirR4.Condition;
      return {
        display: condition.code?.coding?.[0]?.display || condition.code?.text || "Unknown",
        code: condition.code?.coding?.[0]?.code || "",
        system: condition.code?.coding?.[0]?.system || "",
      };
    });

    const allergyList = (allergies?.entry || []).map((entry) => {
      const allergy = entry.resource as fhirR4.AllergyIntolerance;
      return {
        display: allergy.code?.coding?.[0]?.display || allergy.code?.text || "Unknown",
        severity: allergy.criticality || "unknown",
      };
    });

    const medicationList = (medications?.entry || []).map((entry) => {
      const med = entry.resource as fhirR4.MedicationRequest;
      return {
        display:
          med.medicationCodeableConcept?.coding?.[0]?.display ||
          med.medicationCodeableConcept?.text ||
          "Unknown medication",
        status: med.status || "unknown",
      };
    });

    const existingPlans = (existingCarePlans?.entry || []).map((entry) => {
      const plan = entry.resource as fhirR4.CarePlan;
      return {
        id: plan.id,
        title: plan.title || plan.description || "Untitled plan",
        status: plan.status,
        period: plan.period || null,
      };
    });

    // Build ACOG-based recommendations for the gestational age
    const recommendedScreenings = this._getRecommendedScreenings(gestationalAgeWeeks, riskLevel);

    return {
      disclaimer: "Decision support only — clinician review required before any care plan changes.",
      patientId: patient.id,
      birthDate: patient.birthDate || null,
      riskLevel,
      gestationalAgeWeeks: gestationalAgeWeeks || null,
      activeConditions,
      allergies: allergyList,
      currentMedications: medicationList,
      existingCarePlans: existingPlans,
      recommendedScreenings,
      carePlanGuidelineSource: "ACOG",
    };
  }

  private _getRecommendedScreenings(
    gestationalAgeWeeks?: number,
    riskLevel?: string,
  ): string[] {
    const screenings: string[] = [];

    if (!gestationalAgeWeeks) {
      screenings.push("Determine gestational age to guide screening schedule");
      return screenings;
    }

    if (gestationalAgeWeeks <= 13) {
      screenings.push("First trimester combined screening (11-13 weeks) [ACOG PB #226]");
      screenings.push("Initial prenatal labs panel [ACOG Antepartum Record]");
      screenings.push("Dating ultrasound if not already performed [ACOG Committee Opinion #700]");
    }
    if (gestationalAgeWeeks >= 15 && gestationalAgeWeeks <= 22) {
      screenings.push("Quad screen / second trimester screening (15-22 weeks) [ACOG PB #226]");
      screenings.push("Anatomy ultrasound (18-22 weeks) [ACOG Committee Opinion #700]");
    }
    if (gestationalAgeWeeks >= 24 && gestationalAgeWeeks <= 28) {
      screenings.push("Glucose challenge test for GDM (24-28 weeks) [ACOG PB #190]");
      screenings.push("Repeat CBC for anemia screening [ACOG PB #95]");
      screenings.push("Rh antibody screen if Rh-negative [ACOG PB #181]");
    }
    if (gestationalAgeWeeks >= 35 && gestationalAgeWeeks <= 37) {
      screenings.push("Group B Streptococcus (GBS) culture (35-37 weeks) [ACOG PB #797]");
    }
    if (gestationalAgeWeeks >= 36) {
      screenings.push("Weekly NST/BPP if high-risk [ACOG PB #229]");
      screenings.push("Cervical checks as clinically indicated");
    }

    if (riskLevel === "high" || riskLevel === "critical") {
      screenings.push("More frequent BP monitoring [ACOG PB #222]");
      screenings.push("Serial growth ultrasounds every 3-4 weeks [ACOG PB #229]");
      if (gestationalAgeWeeks < 34) {
        screenings.push("Antenatal corticosteroids counseling for fetal lung maturity [ACOG PB #234]");
      }
      if (gestationalAgeWeeks >= 34 && gestationalAgeWeeks < 37) {
        screenings.push("Late-preterm corticosteroids may be considered [ACOG PB #713]");
      }
      if (gestationalAgeWeeks < 32) {
        screenings.push("Magnesium sulfate for neuroprotection if delivery imminent [ACOG Committee Opinion #652]");
      }
    }

    return screenings;
  }
}

export const GenerateCarePlanToolInstance = new GenerateCarePlanTool();
