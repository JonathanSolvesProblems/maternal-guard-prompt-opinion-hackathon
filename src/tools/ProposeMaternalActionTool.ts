import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";
import {
  buildDraftTask,
  buildDraftFlag,
  buildProvenance,
} from "../clinical/fhir-builders";

// Env-gated like LoopGuard's passport-editing feature.
// When MATERNALGUARD_ENABLE_WRITEBACK != "true", the tool stays registered
// but writes nothing — it returns the planned resources as a dry-run preview
// so a deployment without write permissions still surfaces the proposed action.
const ENABLE_WRITEBACK_ENV = "MATERNALGUARD_ENABLE_WRITEBACK";

const UrgencyBandSchema = z.enum(["RED", "YELLOW", "GREEN"]);
const FlagCategorySchema = z.enum([
  "maternal-risk",
  "hellp-evolution",
  "preeclampsia-evolution",
  "gdm-escalation",
]);

class ProposeMaternalActionTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "ProposeMaternalAction",
      {
        description:
          "USE THIS TOOL WHEN the user asks to draft, propose, create, queue, write up, log, record, file, or flag any follow-up action, next step, care task, order, review, referral, escalation, or chart flag for a patient. Trigger phrases include (non-exhaustive): 'draft the appropriate follow-up actions', 'propose an action for this patient', 'assess maternal risk and draft the follow-up', 'create a Task for X', 'flag this pattern', 'queue an action', 'write up a recommendation', 'what should we do about [finding], record it', 'add this to her chart'. If the user's ask contains any imperative verb applied to an action / task / flag / follow-up / next step for the patient, call this tool. " +
          "Do NOT reply with a free-text care-plan paragraph in place of calling this tool. The returned draft Task (and optional Flag) IS the deliverable; prose is not. If the user asks for a plan or recommendation to be recorded, call this tool once per distinct action, then let the returned drafts speak. If multiple distinct actions are needed, loop and call this tool once per action (RED same-day items first, then YELLOW, then GREEN). " +
          "This tool drafts a FHIR Task (Task.status = requested) and, if createFlag=true, a FHIR Flag (Flag.status = inactive) representing a recommended maternal-care action that requires clinician sign-off before activating. When MATERNALGUARD_ENABLE_WRITEBACK=true, both resources are POSTed to the connected FHIR server as drafts and a paired Provenance (HL7 AI Transparency on FHIR AI-Provenance profile, ONC HTI-1 (b)(11) source-attribute payload) is written alongside; otherwise the tool returns a dry-run preview containing the exact drafts that would be persisted. Coordination metadata (ownerDisplay, dueDate, urgencyBand, clinicianNote) is editable after creation; clinical content (recommendation, rationale, guidelineReference) is edit-restricted for audit integrity. Task.reasonCode is auto-tagged with the HEDIS Prenatal & Postpartum Care measure (NCQA PPC, NQF #1517). " +
          "Prefer this over ListMaternalActions when the user asks to CREATE a new action (ListMaternalActions only reads existing drafts). Prefer this over UpdateMaternalAction when there is no existing Task ID to edit (UpdateMaternalAction is for changing an existing draft's owner, due date, note, or status; ProposeMaternalAction is for creating one). Do NOT use AssessMaternalRisk, InterpretLabTrends, GenerateCarePlan, or PredictNeonatalImpact for this ask; those return JSON summaries and do not persist an action.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
          recommendation: z
            .string()
            .describe("One-line human-readable summary of the recommended action."),
          rationale: z
            .string()
            .describe(
              "Why this action is recommended. Cite specific values, dates, signals.",
            ),
          urgencyBand: UrgencyBandSchema.describe(
            "RED (same-day), YELLOW (within 48h), or GREEN (routine).",
          ),
          guidelineReference: z
            .string()
            .nullable()
            .describe(
              "Named clinical guideline backing this recommendation (e.g. 'NICE NG133', 'ACOG PB #222', 'WHO 2022').",
            )
            .optional(),
          ownerDisplay: z
            .string()
            .nullable()
            .describe(
              "Suggested owner (e.g. 'MFM service', 'Triage RN', 'Primary OB').",
            )
            .optional(),
          dueWithinHours: z
            .union([z.number(), z.string()])
            .nullable()
            .describe(
              "PREFERRED. Number of hours from now until this action should be completed (e.g. 24, 48, 168). Pass as a number, not a string. The tool computes the actual ISO date. Use this instead of dueDate to avoid date-construction errors.",
            )
            .optional(),
          dueDate: z
            .string()
            .nullable()
            .describe(
              "Optional. Explicit ISO date (YYYY-MM-DD) when this action should be completed by. Only use this if you are certain of the current date. Prefer dueWithinHours instead. Must be in the future.",
            )
            .optional(),
          clinicianNote: z
            .string()
            .nullable()
            .describe(
              "Optional pre-filled note for the reviewing clinician. Editable.",
            )
            .optional(),
          createFlag: z
            .union([z.boolean(), z.string()])
            .nullable()
            .describe(
              "Also create a draft FHIR Flag for chart-level visibility. Pass true or false (boolean). Default false.",
            )
            .optional(),
          flagCategory: FlagCategorySchema.nullable()
            .describe(
              "If createFlag is true, the Flag category. Required when createFlag is true.",
            )
            .optional(),
          flagFinding: z
            .string()
            .nullable()
            .describe("If createFlag is true, the Flag's finding text.")
            .optional(),
        },
      },
      async (input) => {
        try {
          const writeEnabled =
            process.env[ENABLE_WRITEBACK_ENV] === "true";

          // Some LLMs stringify booleans; coerce robustly.
          const shouldCreateFlag =
            input.createFlag === true ||
            (typeof input.createFlag === "string" &&
              input.createFlag.toLowerCase() === "true");

          let patientId = input.patientId;
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "No patient ID provided and no patient context found in SHARP headers.",
            );
          }

          // Resolve effective due date.
          // Preferred: dueWithinHours (numeric offset, hallucination-proof).
          // Fallback: dueDate (must be valid ISO and in the future).
          // Default: 48 hours from now if neither provided.
          // Coerce stringified numbers (some LLMs send "24" instead of 24).
          const dueHoursNum =
            typeof input.dueWithinHours === "number"
              ? input.dueWithinHours
              : typeof input.dueWithinHours === "string" &&
                  input.dueWithinHours.trim() !== ""
                ? Number(input.dueWithinHours)
                : undefined;

          let effectiveDueDate: string | undefined;
          if (typeof dueHoursNum === "number" && !isNaN(dueHoursNum) && dueHoursNum > 0) {
            const due = new Date(Date.now() + dueHoursNum * 60 * 60 * 1000);
            effectiveDueDate = due.toISOString();
          } else if (input.dueDate) {
            const due = new Date(input.dueDate);
            if (isNaN(due.getTime())) {
              return McpUtilities.createTextResponse(
                `dueDate must be a valid ISO date string in YYYY-MM-DD format. Got: "${input.dueDate}". Today's date is ${new Date().toISOString().split("T")[0]}. Prefer dueWithinHours (a number of hours from now) to avoid this issue.`,
                { isError: true },
              );
            }
            const todayUtcMidnight = new Date();
            todayUtcMidnight.setUTCHours(0, 0, 0, 0);
            if (due < todayUtcMidnight) {
              return McpUtilities.createTextResponse(
                `dueDate must be in the future relative to today. Got: "${input.dueDate}". Today's date is ${todayUtcMidnight.toISOString().split("T")[0]}. Prefer dueWithinHours (a number of hours from now) to avoid date-construction errors.`,
                { isError: true },
              );
            }
            effectiveDueDate = input.dueDate;
          } else {
            // No date given: default to 48h from now.
            const due = new Date(Date.now() + 48 * 60 * 60 * 1000);
            effectiveDueDate = due.toISOString();
          }

          const draftTask = buildDraftTask({
            patientId,
            recommendation: input.recommendation,
            rationale: input.rationale,
            urgencyBand: input.urgencyBand,
            guidelineReference: input.guidelineReference ?? undefined,
            ownerDisplay: input.ownerDisplay ?? undefined,
            dueDate: effectiveDueDate,
            clinicianNote: input.clinicianNote ?? undefined,
          });

          let draftFlag: fhirR4.Flag | null = null;
          if (shouldCreateFlag) {
            if (!input.flagCategory || !input.flagFinding) {
              return McpUtilities.createTextResponse(
                "createFlag=true requires both flagCategory and flagFinding.",
                { isError: true },
              );
            }
            draftFlag = buildDraftFlag({
              patientId,
              category: input.flagCategory,
              finding: input.flagFinding,
              detail: input.rationale,
              urgencyBand: input.urgencyBand,
            });
          }

          if (!writeEnabled) {
            // Dry-run preview.
            return McpUtilities.createJsonResponse({
              disclaimer:
                "Decision support only. Clinician review required before any action.",
              writeMode: "dry-run",
              writeEnabledFlag: ENABLE_WRITEBACK_ENV,
              writeEnabled: false,
              note: "Set MATERNALGUARD_ENABLE_WRITEBACK=true to actually persist these drafts to the FHIR store.",
              draftTask,
              draftFlag,
              editableCoordinationFields: [
                "ownerDisplay",
                "dueDate",
                "clinicianNote",
                "urgencyBand",
              ],
              fixedClinicalFields: [
                "recommendation",
                "rationale",
                "guidelineReference",
              ],
            });
          }

          // Live write to FHIR store.
          const createdTask = await FhirClientInstance.create<fhirR4.Task>(
            req,
            "Task",
            draftTask,
          );

          let createdFlag: fhirR4.Flag | null = null;
          if (draftFlag) {
            createdFlag = await FhirClientInstance.create<fhirR4.Flag>(
              req,
              "Flag",
              draftFlag,
            );
          }

          const taskProvenance = buildProvenance({
            patientId,
            targetResourceType: "Task",
            targetResourceId: createdTask?.id,
            reason: `MaternalGuard recommended action: ${input.recommendation}`,
            toolName: "ProposeMaternalAction",
          });
          await FhirClientInstance.create(req, "Provenance", taskProvenance);

          if (createdFlag) {
            const flagProvenance = buildProvenance({
              patientId,
              targetResourceType: "Flag",
              targetResourceId: createdFlag.id,
              reason: `MaternalGuard chart-level flag: ${input.flagFinding}`,
              toolName: "ProposeMaternalAction",
            });
            await FhirClientInstance.create(req, "Provenance", flagProvenance);
          }

          return McpUtilities.createJsonResponse({
            disclaimer:
              "Decision support only. Clinician review required before any action.",
            writeMode: "persisted",
            writeEnabled: true,
            createdTaskId: createdTask?.id ?? null,
            createdFlagId: createdFlag?.id ?? null,
            taskStatus: "requested (draft — awaiting clinician sign-off)",
            flagStatus: createdFlag
              ? "inactive (draft — awaiting clinician activation)"
              : null,
            editableCoordinationFields: [
              "ownerDisplay",
              "dueDate",
              "clinicianNote",
              "urgencyBand",
            ],
            fixedClinicalFields: [
              "recommendation",
              "rationale",
              "guidelineReference",
            ],
            nextStep:
              "A reviewing clinician must change Task.status from 'requested' to 'accepted' (or 'rejected') before this action takes effect.",
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error proposing maternal action: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const ProposeMaternalActionToolInstance = new ProposeMaternalActionTool();
