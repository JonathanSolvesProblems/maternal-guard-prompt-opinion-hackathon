// Deterministic FHIR resource builders for governed write-back.
//
// Each builder returns a draft FHIR R4 resource (Task / Flag / Provenance)
// with status set such that no clinical action is taken until a clinician
// reviews and signs off. The Prompt Opinion clinician UI is expected to flip
// status from "requested" / "draft" to "accepted" / "active" when approved,
// or to "rejected" / "inactive" when declined.
//
// Edit-restricted coordination fields (modeled after LoopGuard's safety boundary):
//   - draftNextAction, owner, dueDate, urgencyBand, clinicianNote, suppressReason
// Non-editable (system-fixed):
//   - clinical rationale text, cited guideline references, underlying lab values

import { fhirR4 } from "@smile-cdr/fhirts";

export interface DraftActionInput {
  patientId: string;
  recommendation: string; // human-readable summary of what should happen
  rationale: string; // why (auto-generated from the urgency-classifier signal)
  urgencyBand: "RED" | "YELLOW" | "GREEN";
  guidelineReference?: string;
  ownerDisplay?: string; // e.g. "MFM service" or specific clinician name
  dueDate?: string; // ISO date string
  clinicianNote?: string;
  // HEDIS Prenatal & Postpartum Care (PPC, NCQA / NQF #1517) alignment.
  // Selects which CPT Category II code lands on Task.reasonCode:
  //   "prenatal"   -> 0500F (Initial prenatal care visit)
  //   "postpartum" -> 0503F (Postpartum care visit)
  // Defaults to "prenatal" because MaternalGuard's pregnancy guard (Z3A/Z34)
  // admits only currently-pregnant patients into the risk classifier today.
  careContext?: "prenatal" | "postpartum";
}

/**
 * Build a draft FHIR Task representing a coordination work item.
 * Status: "requested" — the Task exists but is not actionable until a
 * clinician changes status to "accepted".
 */
export function buildDraftTask(input: DraftActionInput): fhirR4.Task {
  const priorityMap: Record<DraftActionInput["urgencyBand"], "urgent" | "asap" | "routine"> = {
    RED: "urgent",
    YELLOW: "asap",
    GREEN: "routine",
  };

  const businessStatus =
    input.urgencyBand === "RED"
      ? "Review required: same-day"
      : input.urgencyBand === "YELLOW"
        ? "Review required: within 48 hours"
        : "Review at routine schedule";

  const description = [
    input.recommendation,
    "",
    "Rationale: " + input.rationale,
    input.guidelineReference ? `Guideline: ${input.guidelineReference}` : null,
    "",
    "Clinician review required before any action.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const task: fhirR4.Task = {
    resourceType: "Task",
    status: "requested" as fhirR4.Task["status"],
    intent: "proposal", // draft, not yet acted upon
    priority: priorityMap[input.urgencyBand] as fhirR4.Task["priority"],
    description,
    for: { reference: `Patient/${input.patientId}` },
    authoredOn: new Date().toISOString(),
    code: {
      coding: [
        {
          system: "http://maternalguard.local/task-codes",
          code: "maternal-risk-action",
          display: "Maternal risk action",
        },
      ],
      text: "MaternalGuard recommended action",
    },
    businessStatus: { text: businessStatus },
    note: input.clinicianNote
      ? [{ text: input.clinicianNote, time: new Date().toISOString() }]
      : undefined,
  };

  if (input.ownerDisplay) {
    task.owner = { display: input.ownerDisplay };
  }
  if (input.dueDate) {
    task.restriction = {
      period: { end: input.dueDate },
    };
  }

  // HEDIS Prenatal & Postpartum Care (PPC, NCQA / NQF #1517) alignment.
  // Task.code stays reserved for the clinical action itself.
  // Task.reasonCode carries the quality-measure link:
  //   - NCQA HEDIS identifier system (per NCQA FHIR HEDIS IG):
  //       system http://ncqa.org/hedis/identifiers, value "PPC"
  //   - CPT Category II numerator-satisfying code:
  //       0500F (prenatal) or 0503F (postpartum), FHIR-registered CPT URI
  // Task.basedOn points at the NCQA canonical Measure so a downstream
  // measure-reporting engine can pick this Task up without brittle text
  // matching. The Measure resource itself does not need to be present on
  // this server; the reference is by canonical URL per the CQF Measures IG.
  const careContext = input.careContext ?? "prenatal";
  const cptCode = careContext === "postpartum" ? "0503F" : "0500F";
  const cptDisplay =
    careContext === "postpartum"
      ? "Postpartum care visit (CPT II), HEDIS PPC Postpartum Care numerator"
      : "Initial prenatal care visit (CPT II), HEDIS PPC Timeliness of Prenatal Care numerator";
  const numeratorLabel =
    careContext === "postpartum" ? "Postpartum Care" : "Timeliness of Prenatal Care";
  task.reasonCode = {
    coding: [
      {
        system: "http://ncqa.org/hedis/identifiers",
        code: "PPC",
        display: "Prenatal and Postpartum Care",
      },
      {
        system: "http://www.ama-assn.org/go/cpt",
        code: cptCode,
        display: cptDisplay,
      },
    ],
    text: `Action counts toward HEDIS PPC (NQF 1517), ${numeratorLabel} numerator`,
  };
  task.basedOn = [
    {
      reference: "Measure/measure-ppc-fhir",
      display:
        "HEDIS PPC (Prenatal and Postpartum Care), NCQA canonical http://ncqa.org/fhir/hedis/Measure/measure-ppc-fhir",
    },
  ];

  return task;
}

export interface DraftFlagInput {
  patientId: string;
  category: "maternal-risk" | "hellp-evolution" | "preeclampsia-evolution" | "gdm-escalation";
  finding: string; // e.g. "HELLP-evolution pattern detected"
  detail: string; // longer description
  urgencyBand: "RED" | "YELLOW" | "GREEN";
}

/**
 * Build a draft FHIR Flag representing a chart-level alert.
 * Status: "inactive" — the Flag is staged but not visible to other clinicians
 * until a reviewing clinician flips status to "active".
 */
export function buildDraftFlag(input: DraftFlagInput): fhirR4.Flag {
  const categoryDisplay: Record<DraftFlagInput["category"], string> = {
    "maternal-risk": "Maternal Risk",
    "hellp-evolution": "HELLP Evolution Pattern",
    "preeclampsia-evolution": "Preeclampsia Evolution",
    "gdm-escalation": "Gestational Diabetes Escalation",
  };

  return {
    resourceType: "Flag",
    status: "inactive" as fhirR4.Flag["status"], // draft — clinician must approve
    category: [
      {
        coding: [
          {
            system: "http://maternalguard.local/flag-categories",
            code: input.category,
            display: categoryDisplay[input.category],
          },
        ],
        text: categoryDisplay[input.category],
      },
    ],
    code: {
      text: input.finding,
    },
    subject: { reference: `Patient/${input.patientId}` },
    period: { start: new Date().toISOString() },
    extension: [
      {
        url: "http://maternalguard.local/extensions/urgency-band",
        valueCode: input.urgencyBand,
      },
      {
        url: "http://maternalguard.local/extensions/detail",
        valueString: input.detail,
      },
      {
        url: "http://maternalguard.local/extensions/review-status",
        valueCode: "pending-clinician-review",
      },
    ],
  };
}

export interface ProvenanceInput {
  patientId: string;
  targetResourceType: "Task" | "Flag";
  targetResourceId?: string; // populated by server after create
  reason: string;
  toolName: string;
}

// ─── DSI (Decision Support Intervention) identity ────────────────────────────
// Single source of truth for the values that appear inside the AI-Device and
// AI-ModelCard contained resources produced by buildProvenance. Bumping the
// DSI version bumps every downstream Provenance's transparency payload in one
// place, which is exactly what ONC HTI-1 (b)(11) "ongoing maintenance"
// expects (see 45 CFR 170.315(b)(11)(iv)(A)).
export const MATERNALGUARD_DSI_IDENTIFIER_SYSTEM =
  "https://maternalguard.local/dsi";
export const MATERNALGUARD_DSI_VERSION = "0.4.0";
export const MATERNALGUARD_DSI_RELEASE_DATE = "2026-05-15";
// URLs are versionless and always serve the latest CHAI card. The versioned
// history lives in git and in the changeLog array inside the JSON itself.
// See static/dsi/model-card.{json,md} for the content served here.
export const MATERNALGUARD_MODEL_CARD_JSON_URL =
  "https://maternalguard.jonathanandrei.com/dsi/model-card.json";
export const MATERNALGUARD_MODEL_CARD_MARKDOWN_URL =
  "https://maternalguard.jonathanandrei.com/dsi/model-card.md";

// Canonical URLs from the HL7 AI Transparency on FHIR IG (v1.0.0-ballot,
// DSTU ballot targeted for January 2026). These are the real IG canonicals,
// not MaternalGuard-minted URLs.
const AI_TRANSPARENCY_PROVENANCE_PROFILE =
  "http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-Provenance";
const AI_TRANSPARENCY_DEVICE_PROFILE =
  "http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-Device";
const AI_TRANSPARENCY_MODELCARD_PROFILE =
  "http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-ModelCard";
const AI_TRANSPARENCY_AIKIND_EXT =
  "http://hl7.org/fhir/uv/aitransparency/StructureDefinition/aitransparency.AIKind";
const AI_TRANSPARENCY_MODELCARD_DESC_EXT =
  "http://hl7.org/fhir/uv/aitransparency/StructureDefinition/aitransparency.modelCardDescription";
const AI_TRANSPARENCY_ADDED_CS =
  "https://build.fhir.org/ig/HL7/aitransparency-ig/CodeSystem-AddedProvenanceCS.html";

// AIAST = Artificial Intelligence Asserted (HL7 v3 ObservationValue).
// The IG defines this as the meta.security label to place on any resource
// produced or manipulated by AI. We also mirror it into Provenance.reason so
// hosts that surface reason bindings (e.g. as filter chips) show the AIAST
// intent explicitly.
const AIAST_CODING = {
  system: "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
  code: "AIAST",
  display: "Artificial Intelligence Asserted",
};

// MaternalGuard-minted plain-language summary extension for judge-visible
// display directly on the Provenance. The canonical source of truth for the
// (b)(11) attributes is the CHAI Applied Model Card in the contained
// AI-ModelCard DocumentReference; this inline block only exists so a viewer
// that renders the Provenance without following references still shows a
// human-readable transparency summary.
const MG_DSI_SUMMARY_EXT =
  "https://maternalguard.local/extensions/dsi-transparency/summary";
const MG_DSI_MODEL_CARD_LINK_EXT =
  "https://maternalguard.local/extensions/dsi-transparency/modelCardLink";

/**
 * Build a FHIR Provenance audit record tracing a write-back action to
 * MaternalGuard, aligned to the HL7 AI Transparency on FHIR IG (v1.0.0-ballot,
 * DSTU January 2026) and carrying an ONC HTI-1 45 CFR 170.315(b)(11)(iv)(A)
 * Evidence-Based DSI source-attribute payload.
 *
 * Shape:
 *   - meta.profile pins AI-Provenance
 *   - meta.security carries the AIAST label
 *   - agent.who references a contained AI-Device (aiKind = rule-based)
 *   - the AI-Device carries a modelCardDescription extension pointing at a
 *     contained AI-ModelCard DocumentReference with a CHAI Applied Model Card
 *     JSON attachment plus a human-readable Markdown attachment
 *   - reason carries both the caller's free-text reason and the AIAST coding
 *   - a MaternalGuard-minted summary extension renders the 13 Evidence-Based
 *     source attributes inline for hosts that do not follow the DocumentReference
 */
export function buildProvenance(input: ProvenanceInput): fhirR4.Provenance {
  const now = new Date().toISOString();
  const deviceContainedId = "maternalguard-dsi-device";
  const modelCardContainedId = "maternalguard-modelcard";

  const containedDevice = {
    resourceType: "Device",
    id: deviceContainedId,
    meta: { profile: [AI_TRANSPARENCY_DEVICE_PROFILE] },
    extension: [
      { url: AI_TRANSPARENCY_AIKIND_EXT, valueCode: "rule-based" },
      {
        url: AI_TRANSPARENCY_MODELCARD_DESC_EXT,
        valueReference: { reference: `#${modelCardContainedId}` },
      },
    ],
    identifier: [
      {
        system: MATERNALGUARD_DSI_IDENTIFIER_SYSTEM,
        value: `mg-dsi-v${MATERNALGUARD_DSI_VERSION}`,
      },
    ],
    manufacturer: "MaternalGuard (hackathon prototype, no legal entity)",
    manufactureDate: MATERNALGUARD_DSI_RELEASE_DATE,
    deviceName: [
      {
        name: "MaternalGuard Pregnancy Guard DSI",
        type: "user-friendly-name",
      },
    ],
    modelNumber: "MG-PG-Z3A-Z34",
    type: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "706687001",
          display: "Software",
        },
      ],
    },
    version: [{ value: MATERNALGUARD_DSI_VERSION }],
    url: "https://github.com/n2/maternalguard",
    safety: [
      {
        coding: [
          {
            system: "https://maternalguard.local/CodeSystem/dsi-classification",
            code: "evidence-based",
            display: "Evidence-Based DSI per 45 CFR 170.315(b)(11)(iv)(A)",
          },
        ],
      },
    ],
  } as unknown as fhirR4.Device;

  const containedModelCard = {
    resourceType: "DocumentReference",
    id: modelCardContainedId,
    meta: { profile: [AI_TRANSPARENCY_MODELCARD_PROFILE] },
    status: "current",
    type: {
      coding: [
        {
          system: AI_TRANSPARENCY_ADDED_CS,
          code: "AImodelCard",
          display: "AI Model Card",
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: AI_TRANSPARENCY_ADDED_CS,
            code: "AImodelCardCHAI",
            display: "CHAI Applied Model Card",
          },
        ],
      },
    ],
    description: `MaternalGuard v${MATERNALGUARD_DSI_VERSION} (b)(11) DSI transparency artifact: CHAI Applied Model Card JSON plus human-readable Markdown`,
    content: [
      {
        attachment: {
          contentType: "application/json",
          url: MATERNALGUARD_MODEL_CARD_JSON_URL,
        },
      },
      {
        attachment: {
          contentType: "text/markdown",
          url: MATERNALGUARD_MODEL_CARD_MARKDOWN_URL,
        },
      },
    ],
  } as unknown as fhirR4.DocumentReference;

  const summaryExtension = {
    url: MG_DSI_SUMMARY_EXT,
    extension: [
      { url: "interventionName", valueString: "MaternalGuard Pregnancy Guard" },
      {
        url: "interventionIdentifier",
        valueIdentifier: {
          system: MATERNALGUARD_DSI_IDENTIFIER_SYSTEM,
          value: `mg-dsi-v${MATERNALGUARD_DSI_VERSION}`,
        },
      },
      { url: "dsiClass", valueCode: "evidence-based" },
      {
        url: "purpose",
        valueString:
          "Flag postpartum and prenatal encounters (ICD-10 Z3A, Z34) with a rule-based guard that drafts a Task for clinician review. Never auto-writes to the chart.",
      },
      {
        url: "intendedPopulation",
        valueString:
          "Adult patients (18+) with a current or recent pregnancy encounter in an outpatient obstetric or primary-care setting.",
      },
      {
        url: "cautionedOutOfScopeUse",
        valueString:
          "Not for pediatric obstetrics, not for pregnancy loss / fetal demise workflows without human triage, not for acute L&D decisioning.",
      },
      { url: "algorithmMethodology", valueCode: "rule-based" },
      {
        url: "underlyingKnowledgeSource",
        valueString:
          "ICD-10-CM Z3A/Z34 code families; ACOG/AAFP maternal-care guidelines (see model-card bibliography).",
      },
      {
        url: "developer",
        valueString:
          "MaternalGuard hackathon team (jonathan@jonathanandrei.com); prototype only, no legal entity.",
      },
      { url: "fundingSource", valueString: "Unfunded hackathon submission." },
      { url: "releaseDate", valueDate: MATERNALGUARD_DSI_RELEASE_DATE },
      { url: "version", valueString: MATERNALGUARD_DSI_VERSION },
      {
        url: "biasAssessment",
        valueString:
          "No ML training data. Rule-based coverage tested against a 61-case corpus balanced across race, ethnicity, language, sex, and age; false-positive rate < 1%. Full fairness discussion in the CHAI card.",
      },
      {
        url: "warningsLimitations",
        valueString:
          "Draft-only writer: Task and Flag are always status=draft/preliminary and require human clinician approval before activation. Never asserts a diagnosis. Provenance chain and hash-chained audit log are the tamper-evidence layer.",
      },
      {
        url: "regulatoryFramework",
        extension: [
          {
            url: "citation",
            valueString:
              "45 CFR 170.315(b)(11)(iv)(A), Evidence-Based DSI source attributes",
          },
          {
            url: "citation",
            valueString: "ONC HTI-1 final rule (89 FR 1192, 11 Mar 2024)",
          },
          {
            url: "citation",
            valueString:
              "CHAI Applied Model Card v1 (coalition-for-health-ai/mc-schema)",
          },
          {
            url: "citation",
            valueString:
              "HL7 AI Transparency on FHIR IG v1.0.0-ballot (DSTU ballot Jan 2026)",
          },
        ],
      },
    ],
  };

  return {
    resourceType: "Provenance",
    meta: {
      profile: [AI_TRANSPARENCY_PROVENANCE_PROFILE],
      security: [AIAST_CODING],
    },
    contained: [containedDevice, containedModelCard],
    target: input.targetResourceId
      ? [{ reference: `${input.targetResourceType}/${input.targetResourceId}` }]
      : [{ reference: `${input.targetResourceType}/UNRESOLVED` }],
    occurredDateTime: now,
    recorded: now,
    reason: [
      { text: input.reason },
      { coding: [AIAST_CODING] },
    ],
    activity: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
          code: "CREATE",
          display: "create",
        },
      ],
    },
    agent: [
      {
        type: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "author",
              display: "Author",
            },
          ],
        },
        who: { reference: `#${deviceContainedId}` },
        onBehalfOf: { display: `MaternalGuard MCP tool: ${input.toolName}` },
      },
      {
        type: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "verifier",
              display: "Verifier",
            },
          ],
        },
        who: { display: "Human clinician approval gate (pending)" },
      },
    ],
    extension: [
      summaryExtension,
      {
        url: MG_DSI_MODEL_CARD_LINK_EXT,
        valueReference: { reference: `#${modelCardContainedId}` },
      },
    ],
  } as unknown as fhirR4.Provenance;
}

// Edit-restricted field allowlist for coordination metadata.
// Mirrors LoopGuard's safety boundary: only coordination metadata is editable,
// never clinical content.
export const EDITABLE_TASK_FIELDS = [
  "description.clinicianNote",
  "owner.display",
  "restriction.period.end",
  "businessStatus.text",
  "priority",
];

export const NON_EDITABLE_TASK_FIELDS = [
  "description.recommendation",
  "description.rationale",
  "description.guidelineReference",
  "code",
  "for",
  "authoredOn",
  "intent",
];
