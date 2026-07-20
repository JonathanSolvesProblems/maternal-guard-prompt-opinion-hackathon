import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";
import { buildProvenance } from "../clinical/fhir-builders";

// Env-gated like ProposeMaternalAction.
// When MATERNALGUARD_ENABLE_WRITEBACK != "true", the tool returns a dry-run
// preview instead of writing back to FHIR.
const ENABLE_WRITEBACK_ENV = "MATERNALGUARD_ENABLE_WRITEBACK";

const ActionTypeSchema = z.enum([
  "approve",
  "reject",
  "edit-coordination",
  "activate-flag",
  "dismiss-flag",
]);

class UpdateMaternalActionTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "UpdateMaternalAction",
      {
        description:
          "Updates the status or coordination metadata of an existing draft maternal action created by ProposeMaternalAction. Supports five actions: 'approve' (Task.status: requested -> accepted), 'reject' (Task.status: requested -> rejected with reason), 'edit-coordination' (update owner/dueDate/clinicianNote on a Task without changing status), 'activate-flag' (Flag.status: inactive -> active), 'dismiss-flag' (Flag.status: inactive -> entered-in-error). Clinical content (recommendation, rationale, guideline) cannot be edited via this tool. Provenance audit record is written for every change. Use when the user wants to act on draft items in the chart (e.g. 'approve task X', 'reject the MFM consult', 'change owner to Dr. Smith').",
        inputSchema: {
          action: ActionTypeSchema.describe(
            "The action to perform on the resource.",
          ),
          taskId: z
            .string()
            .nullable()
            .describe(
              "The FHIR Task ID to update. Required for 'approve', 'reject', and 'edit-coordination'. Ignored for flag actions.",
            )
            .optional(),
          flagId: z
            .string()
            .nullable()
            .describe(
              "The FHIR Flag ID to update. Required for 'activate-flag' and 'dismiss-flag'. Ignored for task actions.",
            )
            .optional(),
          reason: z
            .string()
            .nullable()
            .describe(
              "Clinician rationale for the action. Required for 'reject' and 'dismiss-flag'. Optional for others.",
            )
            .optional(),
          ownerDisplay: z
            .string()
            .nullable()
            .describe(
              "New owner display string (e.g. 'Dr. Patel'). Only used with 'edit-coordination'.",
            )
            .optional(),
          dueWithinHours: z
            .union([z.number(), z.string()])
            .nullable()
            .describe(
              "New due window in hours from now. Only used with 'edit-coordination'. Prefer this over dueDate.",
            )
            .optional(),
          dueDate: z
            .string()
            .nullable()
            .describe(
              "New ISO date for the due field. Only used with 'edit-coordination'. Must be in the future.",
            )
            .optional(),
          clinicianNote: z
            .string()
            .nullable()
            .describe(
              "Note to append to the Task. Used with 'approve', 'edit-coordination', or any action where the clinician wants to leave a rationale on the resource.",
            )
            .optional(),
        },
      },
      async (input) => {
        try {
          const writeEnabled =
            process.env[ENABLE_WRITEBACK_ENV] === "true";

          // Resolve dueWithinHours -> ISO date (with stringified-number coercion).
          const dueHoursNum =
            typeof input.dueWithinHours === "number"
              ? input.dueWithinHours
              : typeof input.dueWithinHours === "string" &&
                  input.dueWithinHours.trim() !== ""
                ? Number(input.dueWithinHours)
                : undefined;

          let effectiveDueDate: string | undefined;
          if (
            typeof dueHoursNum === "number" &&
            !isNaN(dueHoursNum) &&
            dueHoursNum > 0
          ) {
            effectiveDueDate = new Date(
              Date.now() + dueHoursNum * 60 * 60 * 1000,
            ).toISOString();
          } else if (input.dueDate) {
            const d = new Date(input.dueDate);
            if (isNaN(d.getTime())) {
              return McpUtilities.createTextResponse(
                `dueDate must be a valid ISO date. Got "${input.dueDate}".`,
                { isError: true },
              );
            }
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            if (d < today) {
              return McpUtilities.createTextResponse(
                `dueDate must be in the future. Got "${input.dueDate}". Prefer dueWithinHours.`,
                { isError: true },
              );
            }
            effectiveDueDate = input.dueDate;
          }

          // ── TASK ACTIONS ─────────────────────────────────────────────
          if (
            input.action === "approve" ||
            input.action === "reject" ||
            input.action === "edit-coordination"
          ) {
            if (!input.taskId) {
              return McpUtilities.createTextResponse(
                `${input.action} requires taskId.`,
                { isError: true },
              );
            }
            // Reject NO LONGER requires a typed reason. The dashboard is
            // meant to be a one-click surface (Pawan's "1000 clicks to
            // copilots" thesis); we don't want to block the button on a
            // free-text field. Chat callers can still pass a reason
            // string; if omitted we record a default so the audit trail
            // stays populated.
            const rejectionReason =
              input.action === "reject"
                ? (input.reason && input.reason.trim()) ||
                  "Rejected by clinician during huddle review"
                : undefined;

            const existing = await FhirClientInstance.read<fhirR4.Task>(
              req,
              `Task/${input.taskId}`,
            );
            if (!existing) {
              return McpUtilities.createTextResponse(
                `Task ${input.taskId} not found.`,
                { isError: true },
              );
            }

            // Reject illegal transitions: draft actions only apply to a
            // Task that is still in `requested`. edit-coordination is
            // allowed on `requested` or `accepted` (owner/due may need
            // adjustment after approval), but never on rejected/cancelled/
            // completed since those are terminal. This prevents a
            // "reject" click from silently reversing a prior approval.
            const currentTaskStatus = existing.status ?? "unknown";
            const isTerminal = (s: string) =>
              ["rejected", "cancelled", "failed", "completed", "entered-in-error"].includes(s);
            if (input.action === "approve" && currentTaskStatus !== "requested") {
              return McpUtilities.createTextResponse(
                `Cannot approve Task ${input.taskId}: current status is "${currentTaskStatus}" (expected "requested"). Draft-only actions cannot mutate a Task that has already been resolved.`,
                { isError: true },
              );
            }
            if (input.action === "reject" && currentTaskStatus !== "requested") {
              return McpUtilities.createTextResponse(
                `Cannot reject Task ${input.taskId}: current status is "${currentTaskStatus}" (expected "requested"). Rejection only applies to a draft that has not yet been approved.`,
                { isError: true },
              );
            }
            if (input.action === "edit-coordination" && isTerminal(currentTaskStatus)) {
              return McpUtilities.createTextResponse(
                `Cannot edit Task ${input.taskId}: current status is "${currentTaskStatus}" (terminal). Coordination edits only apply to open draft or accepted tasks.`,
                { isError: true },
              );
            }

            const updated: fhirR4.Task = JSON.parse(JSON.stringify(existing));
            const newNote = {
              text:
                input.action === "approve"
                  ? `Approved by clinician.${input.clinicianNote ? " Note: " + input.clinicianNote : ""}`
                  : input.action === "reject"
                    ? `Rejected by clinician. Reason: ${rejectionReason}`
                    : `Coordination edited by clinician.${input.clinicianNote ? " Note: " + input.clinicianNote : ""}`,
              time: new Date().toISOString(),
            };

            if (input.action === "approve") {
              updated.status = "accepted" as fhirR4.Task["status"];
            } else if (input.action === "reject") {
              updated.status = "rejected" as fhirR4.Task["status"];
              updated.statusReason = { text: rejectionReason };
            }

            if (input.action === "edit-coordination") {
              if (input.ownerDisplay) {
                updated.owner = { display: input.ownerDisplay };
              }
              if (effectiveDueDate) {
                updated.restriction = {
                  ...(updated.restriction || {}),
                  period: {
                    ...(updated.restriction?.period || {}),
                    end: effectiveDueDate,
                  },
                };
              }
            }

            updated.note = [...(updated.note || []), newNote];

            if (!writeEnabled) {
              return McpUtilities.createJsonResponse({
                disclaimer:
                  "Decision support only. Clinician review required before any action.",
                writeMode: "dry-run",
                writeEnabled: false,
                note: "Set MATERNALGUARD_ENABLE_WRITEBACK=true to persist this update.",
                action: input.action,
                taskId: input.taskId,
                previewUpdatedTask: updated,
              });
            }

            const persisted = await FhirClientInstance.update<fhirR4.Task>(
              req,
              "Task",
              input.taskId,
              updated,
            );

            const effectiveTaskReason =
              input.action === "reject" ? rejectionReason : input.reason;
            const provenance = buildProvenance({
              patientId: existing.for?.reference?.replace("Patient/", "") ?? "",
              targetResourceType: "Task",
              targetResourceId: input.taskId,
              reason: `UpdateMaternalAction action=${input.action}${effectiveTaskReason ? " reason=" + effectiveTaskReason : ""}`,
              toolName: "UpdateMaternalAction",
            });
            await FhirClientInstance.create(req, "Provenance", provenance);

            return McpUtilities.createJsonResponse({
              disclaimer:
                "Decision support only. Clinician review required before any action.",
              writeMode: "persisted",
              writeEnabled: true,
              action: input.action,
              taskId: input.taskId,
              newStatus: persisted?.status ?? updated.status,
              updatedTask: persisted ?? updated,
            });
          }

          // ── FLAG ACTIONS ─────────────────────────────────────────────
          if (
            input.action === "activate-flag" ||
            input.action === "dismiss-flag"
          ) {
            if (!input.flagId) {
              return McpUtilities.createTextResponse(
                `${input.action} requires flagId.`,
                { isError: true },
              );
            }
            // Dismiss NO LONGER requires a typed reason (same rationale
            // as reject on Tasks: the dashboard is a one-click surface).
            // Server supplies a sensible default so audit stays populated.
            const dismissReason =
              input.action === "dismiss-flag"
                ? (input.reason && input.reason.trim()) ||
                  "Dismissed by clinician during huddle review"
                : undefined;

            const existing = await FhirClientInstance.read<fhirR4.Flag>(
              req,
              `Flag/${input.flagId}`,
            );
            if (!existing) {
              return McpUtilities.createTextResponse(
                `Flag ${input.flagId} not found.`,
                { isError: true },
              );
            }

            // Only draft (`inactive`) flags can be activated or dismissed.
            // A flag already in `active` or `entered-in-error` is a
            // completed clinician decision; further dismiss/activate
            // clicks must not silently override it.
            const currentFlagStatus = existing.status ?? "unknown";
            if (currentFlagStatus !== "inactive") {
              return McpUtilities.createTextResponse(
                `Cannot ${input.action.replace("-flag", "")} Flag ${input.flagId}: current status is "${currentFlagStatus}" (expected "inactive"). Only draft flags can be activated or dismissed.`,
                { isError: true },
              );
            }

            const updated: fhirR4.Flag = JSON.parse(JSON.stringify(existing));
            updated.status =
              input.action === "activate-flag"
                ? ("active" as fhirR4.Flag["status"])
                : ("entered-in-error" as fhirR4.Flag["status"]);

            const reviewExt = (updated.extension || []).find(
              (x) =>
                x.url ===
                "http://maternalguard.local/extensions/review-status",
            );
            if (reviewExt) {
              reviewExt.valueCode =
                input.action === "activate-flag"
                  ? "clinician-activated"
                  : "clinician-dismissed";
            }

            if (!writeEnabled) {
              return McpUtilities.createJsonResponse({
                disclaimer:
                  "Decision support only. Clinician review required before any action.",
                writeMode: "dry-run",
                writeEnabled: false,
                note: "Set MATERNALGUARD_ENABLE_WRITEBACK=true to persist this update.",
                action: input.action,
                flagId: input.flagId,
                previewUpdatedFlag: updated,
              });
            }

            const persisted = await FhirClientInstance.update<fhirR4.Flag>(
              req,
              "Flag",
              input.flagId,
              updated,
            );

            const effectiveFlagReason =
              input.action === "dismiss-flag"
                ? dismissReason
                : input.reason;
            const provenance = buildProvenance({
              patientId:
                existing.subject?.reference?.replace("Patient/", "") ?? "",
              targetResourceType: "Flag",
              targetResourceId: input.flagId,
              reason: `UpdateMaternalAction action=${input.action}${effectiveFlagReason ? " reason=" + effectiveFlagReason : ""}`,
              toolName: "UpdateMaternalAction",
            });
            await FhirClientInstance.create(req, "Provenance", provenance);

            return McpUtilities.createJsonResponse({
              disclaimer:
                "Decision support only. Clinician review required before any action.",
              writeMode: "persisted",
              writeEnabled: true,
              action: input.action,
              flagId: input.flagId,
              newStatus: persisted?.status ?? updated.status,
              updatedFlag: persisted ?? updated,
            });
          }

          return McpUtilities.createTextResponse(
            `Unknown action: ${input.action}`,
            { isError: true },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error updating maternal action: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const UpdateMaternalActionToolInstance = new UpdateMaternalActionTool();
