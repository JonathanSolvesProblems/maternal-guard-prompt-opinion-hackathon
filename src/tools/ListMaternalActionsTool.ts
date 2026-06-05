import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

class ListMaternalActionsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "ListMaternalActions",
      {
        description:
          "Lists FHIR Tasks and Flags on the patient that were drafted by MaternalGuard via ProposeMaternalAction. Returns each Task with its status (draft / active / completed / etc.), priority, recommendation, owner, due date, and clinician note. Returns each Flag with category, finding, urgency band, and review status. Use this to read back what is sitting in the patient's chart for clinician review, or to verify a recent write-back succeeded.",
        inputSchema: {
          patientId: z
            .string()
            .nullable()
            .describe("FHIR Patient ID. Optional — uses SHARP header if omitted.")
            .optional(),
          statusFilter: z
            .enum([
              "all",
              "draft",
              "active",
              "completed",
              "rejected",
            ])
            .nullable()
            .describe(
              "Filter Tasks and Flags by status. 'draft' returns Tasks in status=requested AND Flags in status=inactive (the awaiting-review queue). 'active' returns accepted Tasks and active Flags. Default: all.",
            )
            .optional(),
          maternalGuardOnly: z
            .union([z.boolean(), z.string()])
            .nullable()
            .describe(
              "If true, only return Tasks and Flags whose codes/categories were authored by MaternalGuard (filters out unrelated chart items). Default: true.",
            )
            .optional(),
        },
      },
      async (input) => {
        try {
          let patientId = input.patientId;
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "No patient ID provided and no patient context found in SHARP headers.",
            );
          }

          // Coerce boolean input (some LLMs stringify).
          const maternalGuardOnly =
            input.maternalGuardOnly === false ||
            (typeof input.maternalGuardOnly === "string" &&
              input.maternalGuardOnly.toLowerCase() === "false")
              ? false
              : true; // default true

          const statusFilter = input.statusFilter ?? "all";

          const [taskBundle, flagBundle] = await Promise.all([
            FhirClientInstance.search(req, "Task", [
              `subject=Patient/${patientId}`,
              "_sort=-authored-on",
              "_count=50",
            ]),
            FhirClientInstance.search(req, "Flag", [
              `subject=Patient/${patientId}`,
              "_count=50",
            ]),
          ]);

          const tasks: Array<Record<string, unknown>> = [];
          if (taskBundle?.entry?.length) {
            for (const e of taskBundle.entry) {
              const t = e.resource as fhirR4.Task;
              if (maternalGuardOnly && !isMaternalGuardTask(t)) continue;
              if (statusFilter !== "all" && !taskMatchesStatus(t, statusFilter)) {
                continue;
              }
              tasks.push({
                id: t.id,
                status: t.status,
                statusDisplay: explainTaskStatus(t.status),
                intent: t.intent,
                priority: t.priority,
                description: t.description,
                businessStatus: t.businessStatus?.text,
                owner: t.owner?.display,
                dueDate: t.restriction?.period?.end,
                authoredOn: t.authoredOn,
                latestNote: t.note?.[t.note.length - 1]?.text,
                codeText: t.code?.text,
              });
            }
          }

          const flags: Array<Record<string, unknown>> = [];
          if (flagBundle?.entry?.length) {
            for (const e of flagBundle.entry) {
              const f = e.resource as fhirR4.Flag;
              if (maternalGuardOnly && !isMaternalGuardFlag(f)) continue;
              if (statusFilter !== "all" && !flagMatchesStatus(f, statusFilter)) {
                continue;
              }
              const urgencyExt = f.extension?.find(
                (x) => x.url === "http://maternalguard.local/extensions/urgency-band",
              );
              const detailExt = f.extension?.find(
                (x) => x.url === "http://maternalguard.local/extensions/detail",
              );
              const reviewExt = f.extension?.find(
                (x) => x.url === "http://maternalguard.local/extensions/review-status",
              );
              flags.push({
                id: f.id,
                status: f.status,
                statusDisplay: explainFlagStatus(f.status),
                category:
                  f.category?.[0]?.coding?.[0]?.display ||
                  f.category?.[0]?.text,
                categoryCode: f.category?.[0]?.coding?.[0]?.code,
                finding: f.code?.text,
                periodStart: f.period?.start,
                urgencyBand: urgencyExt?.valueCode,
                detail: detailExt?.valueString,
                reviewStatus: reviewExt?.valueCode,
              });
            }
          }

          return McpUtilities.createJsonResponse({
            disclaimer:
              "Decision support only. Clinician review required before any action.",
            patientId,
            statusFilter,
            maternalGuardOnly,
            taskCount: tasks.length,
            flagCount: flags.length,
            tasks,
            flags,
            note:
              tasks.length === 0 && flags.length === 0
                ? "No matching Tasks or Flags on this patient. Either none have been proposed yet, or the filters excluded all results."
                : undefined,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return McpUtilities.createTextResponse(
            `Error listing maternal actions: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }
}

function isMaternalGuardTask(t: fhirR4.Task): boolean {
  const coding = t.code?.coding;
  if (!coding) return false;
  return coding.some(
    (c) =>
      c.system === "http://maternalguard.local/task-codes" &&
      c.code === "maternal-risk-action",
  );
}

function isMaternalGuardFlag(f: fhirR4.Flag): boolean {
  const cat = f.category?.[0]?.coding;
  if (!cat) return false;
  return cat.some(
    (c) => c.system === "http://maternalguard.local/flag-categories",
  );
}

function taskMatchesStatus(t: fhirR4.Task, filter: string): boolean {
  const s = t.status;
  switch (filter) {
    case "draft":
      return s === "requested" || s === "draft";
    case "active":
      return s === "accepted" || s === "in-progress" || s === "ready";
    case "completed":
      return s === "completed";
    case "rejected":
      return s === "rejected" || s === "cancelled";
    default:
      return true;
  }
}

function flagMatchesStatus(f: fhirR4.Flag, filter: string): boolean {
  const s = f.status;
  switch (filter) {
    case "draft":
      return s === "inactive";
    case "active":
      return s === "active";
    case "completed":
      return s === "entered-in-error"; // closest analog
    case "rejected":
      return s === "entered-in-error";
    default:
      return true;
  }
}

function explainTaskStatus(s: string | undefined): string {
  switch (s) {
    case "requested":
      return "Draft — awaiting clinician sign-off";
    case "accepted":
      return "Active — clinician has approved this action";
    case "rejected":
      return "Rejected — clinician declined this action";
    case "completed":
      return "Completed — action has been performed";
    case "cancelled":
      return "Cancelled";
    case "in-progress":
      return "In progress";
    default:
      return s ?? "unknown";
  }
}

function explainFlagStatus(s: string | undefined): string {
  switch (s) {
    case "inactive":
      return "Draft — awaiting clinician activation";
    case "active":
      return "Active — visible to the care team";
    case "entered-in-error":
      return "Closed";
    default:
      return s ?? "unknown";
  }
}

export const ListMaternalActionsToolInstance = new ListMaternalActionsTool();
