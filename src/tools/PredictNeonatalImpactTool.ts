import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";

// Maternal ICD-10 code prefix -> neonatal risk projections
const MATERNAL_TO_NEONATAL_MAP: Array<{
  prefix: string;
  label: string;
  neonatalRisks: string[];
  acogReference: string;
}> = [
  {
    prefix: "O14",
    label: "Preeclampsia",
    neonatalRisks: [
      "Iatrogenic preterm delivery (risk rises if severe features develop before 34 weeks)",
      "Intrauterine growth restriction (IUGR) / small-for-gestational-age",
      "NICU admission for prematurity complications",
      "Increased stillbirth risk if uncontrolled",
    ],
    acogReference: "ACOG PB #222 (Preeclampsia)",
  },
  {
    prefix: "O15",
    label: "Eclampsia",
    neonatalRisks: [
      "Emergent preterm delivery likely — full NICU preparation required",
      "Hypoxic-ischemic injury risk if maternal seizure during delivery",
      "IUGR and SGA",
    ],
    acogReference: "ACOG PB #222 (Preeclampsia) + PB #203 (Chronic HTN)",
  },
  {
    prefix: "O13",
    label: "Gestational hypertension",
    neonatalRisks: [
      "IUGR risk if BP progresses or preeclampsia develops",
      "Late-preterm delivery risk (37 weeks commonly planned for non-severe disease)",
    ],
    acogReference: "ACOG PB #203 (Chronic HTN in Pregnancy)",
  },
  {
    prefix: "O10",
    label: "Pre-existing hypertension",
    neonatalRisks: [
      "IUGR / placental insufficiency",
      "Preterm delivery if superimposed preeclampsia develops",
    ],
    acogReference: "ACOG PB #203 (Chronic HTN in Pregnancy)",
  },
  {
    prefix: "O11",
    label: "Pre-existing hypertension with superimposed preeclampsia",
    neonatalRisks: [
      "High IUGR / placental insufficiency risk",
      "Preterm delivery likely",
    ],
    acogReference: "ACOG PB #203 (Chronic HTN in Pregnancy) + PB #222 (Preeclampsia)",
  },
  {
    prefix: "O24",
    label: "Diabetes in pregnancy (GDM or pre-existing)",
    neonatalRisks: [
      "Macrosomia (>4000g) — risk of shoulder dystocia and birth trauma",
      "Neonatal hypoglycemia in first 24-48 hours of life",
      "Respiratory distress syndrome (delayed lung maturity)",
      "Hyperbilirubinemia",
      "Cardiomyopathy (septal hypertrophy) with poor glycemic control",
      "Congenital anomalies if pre-existing diabetes with poor 1st-trimester control",
    ],
    acogReference: "ACOG PB #190 (GDM) / PB #201 (Pregestational Diabetes)",
  },
  {
    prefix: "E10",
    label: "Type 1 diabetes",
    neonatalRisks: [
      "Congenital anomalies (cardiac, neural tube, caudal regression) — highest risk with poor periconceptional control",
      "Macrosomia, neonatal hypoglycemia, RDS",
    ],
    acogReference: "ACOG PB #201 (Pregestational Diabetes)",
  },
  {
    prefix: "E11",
    label: "Type 2 diabetes",
    neonatalRisks: [
      "Congenital anomalies if poor periconceptional glycemic control",
      "Macrosomia, neonatal hypoglycemia, RDS",
    ],
    acogReference: "ACOG PB #201 (Pregestational Diabetes)",
  },
  {
    prefix: "O30",
    label: "Multiple gestation",
    neonatalRisks: [
      "Preterm delivery (average 35-36w twins, 32-33w triplets)",
      "Twin-twin transfusion in monochorionic",
      "Lower birth weights",
      "Higher NICU admission",
    ],
    acogReference: "ACOG PB #231 (Multifetal Gestations)",
  },
  {
    prefix: "O44",
    label: "Placenta previa",
    neonatalRisks: [
      "Preterm delivery if antepartum hemorrhage occurs",
      "Blood loss / anemia at delivery",
    ],
    acogReference: "ACOG Committee Opinion (Placenta Previa)",
  },
  {
    prefix: "O09.1",
    label: "Pregnancy with history of ectopic pregnancy",
    neonatalRisks: [
      "Early pregnancy loss risk (primarily maternal impact)",
    ],
    acogReference: "ACOG guidance on recurrent pregnancy loss",
  },
  {
    prefix: "O36",
    label: "Maternal care for known/suspected fetal problems",
    neonatalRisks: [
      "Fetal-specific per condition — consult MFM",
      "Likely NICU evaluation at delivery",
    ],
    acogReference: "ACOG Antepartum Fetal Surveillance (PB #229)",
  },
  {
    prefix: "O46",
    label: "Antepartum hemorrhage",
    neonatalRisks: [
      "Preterm delivery risk",
      "Neonatal anemia if significant maternal blood loss",
    ],
    acogReference: "ACOG PB #183 (Postpartum Hemorrhage)",
  },
  {
    prefix: "O09.21",
    label: "Pregnancy with history of preterm labor",
    neonatalRisks: [
      "Recurrent preterm birth risk ~30-40%",
      "Consider 17-OHPC / cervical length surveillance",
      "RDS, IVH risk if delivered <34 weeks",
    ],
    acogReference: "ACOG PB #234 (Antenatal Corticosteroid Therapy)",
  },
];

// Maternal lab thresholds that raise neonatal risk concern
type LabRisk = {
  loinc: string;
  label: string;
  threshold: { min?: number; max?: number };
  neonatalRisk: string;
};

const MATERNAL_LAB_NEONATAL_RISKS: LabRisk[] = [
  {
    loinc: "777-3",
    label: "Platelets",
    threshold: { min: 100 },
    neonatalRisk:
      "Maternal thrombocytopenia <100K (HELLP pattern) — neonatal thrombocytopenia possible; delivery likely imminent",
  },
  {
    loinc: "1920-8",
    label: "AST",
    threshold: { max: 70 },
    neonatalRisk:
      "Maternal AST >70 U/L suggests HELLP — high likelihood of iatrogenic preterm delivery; full neonatal resuscitation prep",
  },
  {
    loinc: "718-7",
    label: "Hemoglobin",
    threshold: { min: 10.0 },
    neonatalRisk:
      "Maternal Hgb <10 g/dL — associated with low birth weight and preterm delivery risk",
  },
  {
    loinc: "2888-6",
    label: "Urine protein",
    threshold: { max: 300 },
    neonatalRisk:
      "Significant proteinuria >=300 mg/dL indicates severe preeclampsia features — elevated risk of preterm iatrogenic delivery",
  },
  {
    loinc: "1558-6",
    label: "Fasting glucose",
    threshold: { max: 95 },
    neonatalRisk:
      "Persistently elevated fasting glucose suggests suboptimal GDM control — higher risk of macrosomia and neonatal hypoglycemia",
  },
];

class PredictNeonatalImpactTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "PredictNeonatalImpact",
      {
        description:
          "Predicts neonatal/newborn risk implications from the pregnant patient's current maternal FHIR data (conditions + recent labs + gestational age). Returns structured neonatal risk projections with ACOG references so the platform AI can brief both OB and pediatric/NICU teams.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
          gestationalAgeWeeks: z
            .number()
            .nullable()
            .describe("Gestational age in weeks. Drives prematurity risk stratification.")
            .optional(),
        },
      },
      async ({ patientId, gestationalAgeWeeks }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "No patient ID provided and no patient context found in SHARP headers.",
            );
          }

          const [conditions, observations] = await Promise.all([
            FhirClientInstance.search(req, "Condition", [`patient=${patientId}`]),
            FhirClientInstance.search(req, "Observation", [
              `patient=${patientId}`,
              "_sort=-date",
              "_count=50",
            ]),
          ]);

          const result = this._buildNeonatalImpact(conditions, observations, gestationalAgeWeeks);
          return McpUtilities.createJsonResponse(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error predicting neonatal impact: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _buildNeonatalImpact(
    conditions: fhirR4.Bundle | null,
    observations: fhirR4.Bundle | null,
    gestationalAgeWeeks?: number | null,
  ) {
    const maternalRiskDrivers: Array<{
      source: string;
      label: string;
      code?: string;
      neonatalRisks: string[];
      acogReference: string;
    }> = [];

    // Map active conditions to neonatal risks
    if (conditions?.entry?.length) {
      for (const entry of conditions.entry) {
        const condition = entry.resource as fhirR4.Condition;
        const code = condition.code?.coding?.[0]?.code || "";
        const display = condition.code?.coding?.[0]?.display || condition.code?.text || "";
        const status = condition.clinicalStatus?.coding?.[0]?.code || "unknown";
        if (status !== "active") continue;

        for (const mapping of MATERNAL_TO_NEONATAL_MAP) {
          if (code.startsWith(mapping.prefix)) {
            maternalRiskDrivers.push({
              source: "Condition",
              label: `${mapping.label} (${display}, ${code})`,
              code,
              neonatalRisks: mapping.neonatalRisks,
              acogReference: mapping.acogReference,
            });
            break;
          }
        }
      }
    }

    // Map abnormal lab values to neonatal risks
    if (observations?.entry?.length) {
      const labsByLoinc = new Map<string, fhirR4.Observation>();
      for (const entry of observations.entry) {
        const obs = entry.resource as fhirR4.Observation;
        const code = obs.code?.coding?.[0]?.code;
        if (!code) continue;
        const existing = labsByLoinc.get(code);
        if (!existing) {
          labsByLoinc.set(code, obs);
          continue;
        }
        const existingDate = existing.effectiveDateTime || existing.issued || "";
        const newDate = obs.effectiveDateTime || obs.issued || "";
        if (newDate > existingDate) labsByLoinc.set(code, obs);
      }

      for (const labRisk of MATERNAL_LAB_NEONATAL_RISKS) {
        const obs = labsByLoinc.get(labRisk.loinc);
        const value = obs?.valueQuantity?.value;
        if (obs == null || value == null) continue;

        const belowMin = labRisk.threshold.min !== undefined && value < labRisk.threshold.min;
        const aboveMax = labRisk.threshold.max !== undefined && value > labRisk.threshold.max;
        if (belowMin || aboveMax) {
          maternalRiskDrivers.push({
            source: "Observation",
            label: `${labRisk.label} ${value} ${obs.valueQuantity?.unit || ""}`.trim(),
            code: labRisk.loinc,
            neonatalRisks: [labRisk.neonatalRisk],
            acogReference: "See condition-level ACOG reference",
          });
        }
      }
    }

    // Gestational-age-driven prematurity risk band
    const prematurityBand = this._getPrematurityBand(gestationalAgeWeeks);

    return {
      disclaimer:
        "Decision support for mother-baby dyad planning — neonatology/NICU consult recommended for elevated risk. Clinician review required.",
      analysisDate: new Date().toISOString().split("T")[0],
      gestationalAgeWeeks: gestationalAgeWeeks ?? null,
      prematurityBand,
      maternalRiskDrivers,
      neonatalReadinessChecklist: this._getReadinessChecklist(
        maternalRiskDrivers,
        gestationalAgeWeeks,
      ),
    };
  }

  private _getPrematurityBand(gestationalAgeWeeks?: number | null): {
    band: string;
    risks: string[];
    acogReference: string;
  } {
    if (!gestationalAgeWeeks) {
      return {
        band: "Unknown — determine gestational age to stratify",
        risks: [],
        acogReference: "ACOG PB #234 (Antenatal Corticosteroid Therapy)",
      };
    }
    if (gestationalAgeWeeks < 28) {
      return {
        band: "Extreme preterm (<28 weeks)",
        risks: [
          "Highest NICU mortality and morbidity",
          "IVH, ROP, BPD, NEC risks",
          "Delivery at tertiary center with NICU Level III-IV required",
        ],
        acogReference: "ACOG PB #234 (Antenatal Corticosteroid Therapy)",
      };
    }
    if (gestationalAgeWeeks < 32) {
      return {
        band: "Very preterm (28-31 weeks)",
        risks: [
          "Significant RDS, IVH, NEC risk",
          "Antenatal corticosteroids indicated if delivery anticipated",
          "Magnesium sulfate for neuroprotection if <32w delivery imminent",
          "NICU Level III required",
        ],
        acogReference: "ACOG PB #234 (Antenatal Corticosteroid Therapy)",
      };
    }
    if (gestationalAgeWeeks < 34) {
      return {
        band: "Moderate preterm (32-33 weeks)",
        risks: [
          "RDS risk — antenatal corticosteroids indicated if delivery anticipated <34w",
          "Feeding immaturity, temp instability",
          "NICU observation likely",
        ],
        acogReference: "ACOG PB #234 (Antenatal Corticosteroid Therapy)",
      };
    }
    if (gestationalAgeWeeks < 37) {
      return {
        band: "Late preterm (34-36 weeks)",
        risks: [
          "Transient tachypnea of the newborn",
          "Hypoglycemia (especially GDM)",
          "Temperature instability, feeding difficulties",
          "Late-preterm corticosteroids may be considered per ACOG PB #713",
        ],
        acogReference: "ACOG PB #713 (Antenatal Corticosteroid Therapy for Fetal Maturation)",
      };
    }
    if (gestationalAgeWeeks < 39) {
      return {
        band: "Early term (37-38 weeks)",
        risks: [
          "Mild increase in respiratory morbidity vs. full term",
          "Avoid non-medically-indicated delivery before 39 weeks",
        ],
        acogReference: "ACOG Committee Opinion #765 (Avoidance of Nonmedically Indicated Early-Term Deliveries)",
      };
    }
    return {
      band: "Full term (>=39 weeks)",
      risks: ["Standard newborn care"],
      acogReference: "Routine newborn care guidelines",
    };
  }

  private _getReadinessChecklist(
    drivers: Array<{ label: string }>,
    gestationalAgeWeeks?: number | null,
  ): string[] {
    const checklist: string[] = [];
    const hasGDM = drivers.some((d) => /diabetes/i.test(d.label));
    const hasPreeclampsia = drivers.some((d) => /preeclampsia|eclampsia|HELLP/i.test(d.label));
    const hasPreterm = drivers.some((d) => /preterm/i.test(d.label));

    if (gestationalAgeWeeks != null && gestationalAgeWeeks < 34) {
      checklist.push("Counsel on antenatal corticosteroids (ACOG PB #234) if delivery anticipated within 7 days");
      checklist.push("Magnesium sulfate for neuroprotection if delivery anticipated <32 weeks");
    }
    if (gestationalAgeWeeks != null && gestationalAgeWeeks >= 34 && gestationalAgeWeeks < 37) {
      checklist.push("Consider late-preterm corticosteroids per ACOG PB #713");
    }
    if (hasPreeclampsia) {
      checklist.push("Notify neonatology team of possible preterm delivery and IUGR / SGA risk");
      checklist.push("Prepare for possible magnesium sulfate at delivery (for mother; neonatal effects monitored)");
    }
    if (hasGDM) {
      checklist.push("Newborn blood glucose monitoring protocol (first 24-48 hours)");
      checklist.push("Plan for macrosomia management (shoulder dystocia preparation) if EFW >4000g");
    }
    if (hasPreterm) {
      checklist.push("NICU level assessment — Level III minimum for <32w, Level II acceptable for 32-34w");
    }
    if (checklist.length === 0) {
      checklist.push("Standard newborn readiness — no elevated neonatal risk drivers detected from maternal data");
    }
    return checklist;
  }
}

export const PredictNeonatalImpactToolInstance = new PredictNeonatalImpactTool();
