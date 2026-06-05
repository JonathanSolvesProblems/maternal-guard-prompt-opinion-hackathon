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

/**
 * Build a FHIR Provenance audit record tracing a write-back action to MaternalGuard.
 * Used for downstream audit (who/what wrote this draft, when, why).
 */
export function buildProvenance(input: ProvenanceInput): fhirR4.Provenance {
  return {
    resourceType: "Provenance",
    target: input.targetResourceId
      ? [{ reference: `${input.targetResourceType}/${input.targetResourceId}` }]
      : [{ reference: `${input.targetResourceType}/UNRESOLVED` }],
    recorded: new Date().toISOString(),
    reason: [
      {
        text: input.reason,
      },
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
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "assembler",
              display: "Assembler",
            },
          ],
        },
        who: {
          display: `MaternalGuard MCP tool: ${input.toolName}`,
        },
      },
    ],
  };
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
