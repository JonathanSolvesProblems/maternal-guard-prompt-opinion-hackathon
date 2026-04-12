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
          "Retrieves a pregnant patient's conditions, allergies, medications, and existing care plans from FHIR, then compiles the clinical context needed to generate a personalized prenatal/postnatal FHIR R4 CarePlan. Returns structured patient data along with ACOG guideline references so the platform AI can generate an appropriate care plan.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe(
              "The FHIR Patient resource ID. Optional if patient context is provided via SHARP headers.",
            )
            .optional(),
          riskLevel: z
            .string()
            .nullable()
            .describe(
              'Overall risk level from a prior AssessMaternalRisk call. One of: "low", "moderate", "high", "critical". Defaults to "moderate" if not provided.',
            )
            .optional(),
          gestationalAgeWeeks: z
            .number()
            .nullable()
            .describe(
              "Current gestational age in weeks. Helps determine appropriate screenings and visit schedule.",
            )
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
            gestationalAgeWeeks,
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
      disclaimer:
        "This data is provided to support care plan generation. Any care plan must be reviewed and approved by a qualified healthcare provider.",
      patientId: patient.id,
      birthDate: patient.birthDate || null,
      riskLevel,
      gestationalAgeWeeks: gestationalAgeWeeks || null,
      activeConditions,
      allergies: allergyList,
      currentMedications: medicationList,
      existingCarePlans: existingPlans,
      recommendedScreenings,
      carePlanGuidelines: {
        source: "ACOG (American College of Obstetricians and Gynecologists)",
        lowRiskVisitSchedule: "Every 4 weeks until 28 weeks, every 2 weeks until 36 weeks, then weekly",
        highRiskVisitSchedule: "More frequent visits as clinically indicated, often every 1-2 weeks",
        standardPrenatalLabs: [
          "Complete blood count (CBC)",
          "Blood type and Rh factor",
          "Urinalysis",
          "Hepatitis B surface antigen",
          "HIV screening",
          "Syphilis screening",
          "Rubella immunity",
          "Glucose challenge test (24-28 weeks)",
          "Group B Streptococcus culture (35-37 weeks)",
        ],
      },
      fhirCarePlanTemplate: {
        resourceType: "CarePlan",
        status: "active",
        intent: "plan",
        subject: { reference: `Patient/${patient.id}` },
        category: [
          {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: "134435003",
                display: "Routine antenatal care",
              },
            ],
          },
        ],
        description:
          "Use this template structure. Populate 'activity' array with scheduled visits, labs, screenings, referrals, and patient education based on the patient data and risk level above.",
      },
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
      screenings.push("First trimester combined screening (11-13 weeks)");
      screenings.push("Initial prenatal labs panel");
      screenings.push("Dating ultrasound if not already performed");
    }
    if (gestationalAgeWeeks >= 15 && gestationalAgeWeeks <= 22) {
      screenings.push("Quad screen / second trimester screening (15-22 weeks)");
      screenings.push("Anatomy ultrasound (18-22 weeks)");
    }
    if (gestationalAgeWeeks >= 24 && gestationalAgeWeeks <= 28) {
      screenings.push("Glucose challenge test for GDM (24-28 weeks)");
      screenings.push("Repeat CBC for anemia screening");
      screenings.push("Rh antibody screen if Rh-negative");
    }
    if (gestationalAgeWeeks >= 35 && gestationalAgeWeeks <= 37) {
      screenings.push("Group B Streptococcus (GBS) culture (35-37 weeks)");
    }
    if (gestationalAgeWeeks >= 36) {
      screenings.push("Weekly NST/BPP if high-risk");
      screenings.push("Cervical checks as clinically indicated");
    }

    if (riskLevel === "high" || riskLevel === "critical") {
      screenings.push("More frequent BP monitoring");
      screenings.push("Serial growth ultrasounds every 3-4 weeks");
      screenings.push("Consider antenatal corticosteroids counseling if <34 weeks");
    }

    return screenings;
  }
}

export const GenerateCarePlanToolInstance = new GenerateCarePlanTool();
