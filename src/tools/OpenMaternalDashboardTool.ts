import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";
import {
  classifyUrgency,
  VitalReading,
  LabReading,
  UrgencyAssessment,
} from "../clinical/urgency-classifier";
import {
  prefabApp,
  prefabAppToCallToolResult,
  column,
  row,
  grid,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  heading,
  text,
  muted,
  badge,
  metric,
  input,
  label,
  button,
  separator,
  alert,
  alertTitle,
  alertDescription,
  callTool,
  showToast,
  PrefabNode,
  BadgeVariant,
} from "../prefab";

const BUNDLED_PATIENT_IDS_ENV = "MATERNALGUARD_BUNDLED_PATIENT_IDS";

function bandToBadgeVariant(band: string): BadgeVariant {
  return ({ RED: "destructive", YELLOW: "warning", GREEN: "success" } as Record<string, BadgeVariant>)[band] ?? "secondary";
}

interface PanelEntry {
  id: string;
  display: string;
  urgency: UrgencyAssessment;
  tasks: fhirR4.Task[];
  flags: fhirR4.Flag[];
}

function isMaternalGuardTask(t: fhirR4.Task): boolean {
  return !!t.code?.coding?.some(
    (c) =>
      c.system === "http://maternalguard.local/task-codes" &&
      c.code === "maternal-risk-action",
  );
}

function isMaternalGuardFlag(f: fhirR4.Flag): boolean {
  return !!f.category?.[0]?.coding?.some(
    (c) => c.system === "http://maternalguard.local/flag-categories",
  );
}

// Resolve current gestational age (weeks) from the pregnancy Condition. We
// look for ICD-10 Z34.* ("Encounter for supervision of normal pregnancy") on
// the Condition and use its onsetDateTime as the effective LMP (assuming a
// term of 40 weeks). Returns null if no such Condition is found.
function _gestationalAgeFromConditions(
  bundle: fhirR4.Bundle | undefined,
): number | null {
  if (!bundle?.entry?.length) return null;
  for (const e of bundle.entry) {
    const c = e.resource as fhirR4.Condition | undefined;
    const code = c?.code?.coding?.find((cc) =>
      (cc.code ?? "").toUpperCase().startsWith("Z34"),
    )?.code;
    if (!code) continue;
    const onset = c?.onsetDateTime;
    if (!onset) continue;
    const start = new Date(onset).getTime();
    if (Number.isNaN(start)) continue;
    const now = Date.now();
    const weeks = Math.floor((now - start) / (7 * 24 * 3600 * 1000));
    if (weeks < 0 || weeks > 45) continue;
    return weeks;
  }
  return null;
}

// Compute the whole hours between now and a Task's restriction period end.
// Falls back to 24 when the Task has no due date. Never returns negative.
function _dueHoursFromTask(task: fhirR4.Task): string {
  const end = task.restriction?.period?.end;
  if (!end) return "24";
  const dueMs = new Date(end).getTime();
  if (Number.isNaN(dueMs)) return "24";
  const diffH = Math.round((dueMs - Date.now()) / 3600_000);
  return String(Math.max(0, diffH));
}

class OpenMaternalDashboardTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "OpenMaternalDashboard",
      {
        description:
          "**Use this for the interactive MaternalGuard Morning Huddle dashboard** (Prefab MCP App / in-chat visual UI in Prompt Opinion). Renders inline in the chat with ranked cohort cards (RED/YELLOW/GREEN urgency bands), contributing clinical signals (HELLP-evolution, hypertensive BP, rising AST, falling platelets, proteinuria), and per-patient draft Tasks with Approve / Reject / Save-edits buttons plus draft Flags with Activate / Dismiss buttons. Button clicks route to UpdateMaternalAction. **Prefer this over AssessMaternalRisk, InterpretLabTrends, ScreenSocialDeterminants, GenerateCarePlan, PredictNeonatalImpact, and MaternalPanelScan whenever the user wants a visual dashboard, morning huddle, triage board, panel view, cohort view, or GUI.** Do not confuse: OpenMaternalDashboard = interactive UI; the others = JSON summaries. Pass mode='default' to launch the standard morning-huddle view.",
        inputSchema: {
          mode: z
            .enum(["default", "morning-huddle", "cohort"])
            .nullable()
            .describe(
              "Which dashboard view to render. Always pass 'default' unless you have a specific reason to choose another.",
            )
            .optional(),
        },
        // Per fastmcp source (FastMCPApp.ui decorator → tool._meta), plus
        // LoopGuard's live wire capture:
        //   _meta.ui.resourceUri = "ui://prefab/renderer.html"
        //   _meta.ui.visibility  = ["model"]
        //   _meta.fastmcp.app    = <app name>
        //   _meta.fastmcp.tags   = []
        // Note: no `annotations` block and no `execution` block, matching
        // LoopGuard's open_passport_app exactly. LoopGuard's UI tool has
        // neither; both fields were removed here because our observed
        // rendering behavior matched LoopGuard best without them.
        _meta: {
          ui: {
            resourceUri: "ui://prefab/renderer.html",
            visibility: ["model"],
          },
          fastmcp: {
            tags: [],
            app: "MaternalGuard Morning Huddle",
          },
        },
      },
      async (_input) => {
        // PRIMARY: the selected patient from SHARP headers.
        // OPTIONAL: a bundled cohort env var (used only if explicitly configured).
        // The dashboard always works for the currently-selected patient without
        // requiring any env-var configuration.
        const selectedPatientId = FhirUtilities.getPatientIdIfContextExists(req);
        const bundled = (process.env[BUNDLED_PATIENT_IDS_ENV] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const cohort: string[] = [];
        if (selectedPatientId) cohort.push(selectedPatientId);
        for (const id of bundled) {
          if (!cohort.includes(id)) cohort.push(id);
        }

        if (cohort.length === 0) {
          // No patient selected and no bundled cohort. Return an explanatory app.
          const view = column({ gap: 4, cssClass: "p-6" }, [
            heading("MaternalGuard Morning Huddle", 2),
            alert({ variant: "warning" }, [
              alertTitle("No patient context"),
              alertDescription(
                "Select a patient in this workspace, or configure MATERNALGUARD_BUNDLED_PATIENT_IDS for a multi-patient cohort. The dashboard then renders that patient or cohort.",
              ),
            ]),
          ]);
          return prefabAppToCallToolResult(
            prefabApp({
              title: "MaternalGuard Morning Huddle",
              cssClass: "bg-slate-50 text-slate-950",
              view,
            }),
          );
        }

        // Fetch all patients in parallel so dashboard render time stays
        // near-constant regardless of cohort size.
        const perPatientResults = await Promise.all(
          cohort.map(async (pid): Promise<PanelEntry | null> => {
            try {
              const [patient, obs, tasks, flags, conditions] = await Promise.all([
                FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${pid}`),
                FhirClientInstance.search(req, "Observation", [
                  `patient=${pid}`,
                  "_count=100",
                  "_sort=-date",
                ]),
                FhirClientInstance.search(req, "Task", [
                  `subject=Patient/${pid}`,
                  "_count=20",
                ]),
                FhirClientInstance.search(req, "Flag", [
                  `subject=Patient/${pid}`,
                  "_count=20",
                ]),
                FhirClientInstance.search(req, "Condition", [
                  `patient=${pid}`,
                  "_count=50",
                ]),
              ]);
              if (!patient) return null;

              const bp: VitalReading[] = [];
              const labs: LabReading[] = [];
              for (const e of obs?.entry ?? []) {
                const o = e.resource as fhirR4.Observation;
                const code = o.code?.coding?.[0]?.code ?? "";
                const date = o.effectiveDateTime ?? o.issued ?? "";
                if (code === "85354-9" && o.component?.length) {
                  const sys = o.component.find(
                    (c) => c.code?.coding?.[0]?.code === "8480-6",
                  )?.valueQuantity?.value;
                  const dia = o.component.find(
                    (c) => c.code?.coding?.[0]?.code === "8462-4",
                  )?.valueQuantity?.value;
                  bp.push({
                    date,
                    systolicMmHg: typeof sys === "number" ? sys : null,
                    diastolicMmHg: typeof dia === "number" ? dia : null,
                  });
                } else if (typeof o.valueQuantity?.value === "number") {
                  labs.push({
                    code,
                    display: o.code?.coding?.[0]?.display ?? "",
                    value: o.valueQuantity.value,
                    unit: o.valueQuantity.unit,
                    date,
                  });
                }
              }

              // Resolve gestational age from the pregnancy Condition (Z34.*)
              // onsetDateTime, so the classifier's gestational-age weighting
              // at >=32w actually fires (previously we passed null and lost
              // the +10 uplift on severe scores).
              const gestationalAgeWeeks = _gestationalAgeFromConditions(
                conditions ?? undefined,
              );

              const urgency = classifyUrgency({
                gestationalAgeWeeks,
                bpReadings: bp,
                labReadings: labs,
              });

              const mgTasks = (tasks?.entry ?? [])
                .map((e) => e.resource as fhirR4.Task)
                .filter(isMaternalGuardTask);
              const mgFlags = (flags?.entry ?? [])
                .map((e) => e.resource as fhirR4.Flag)
                .filter(isMaternalGuardFlag);

              const family = patient.name?.[0]?.family ?? "";
              const given = (patient.name?.[0]?.given ?? []).join(" ");
              const display = `${family}${given ? ", " + given : ""}` || pid;

              return { id: pid, display, urgency, tasks: mgTasks, flags: mgFlags };
            } catch (err) {
              // Surface the error to the server log so an expired FHIR
              // token or a 4xx on one patient does not vanish silently.
              console.error(
                `[OpenMaternalDashboard] error scanning patient ${pid}:`,
                err instanceof Error ? err.message : err,
              );
              return null;
            }
          }),
        );

        const panel: PanelEntry[] = perPatientResults.filter(
          (r): r is PanelEntry => r !== null,
        );

        panel.sort((a, b) => b.urgency.score - a.urgency.score);
        const red = panel.filter((p) => p.urgency.band === "RED").length;
        const yel = panel.filter((p) => p.urgency.band === "YELLOW").length;
        const grn = panel.filter((p) => p.urgency.band === "GREEN").length;

        const headerCard = column(
          {
            gap: 3,
            cssClass:
              "rounded-lg border border-slate-200 bg-white p-5 shadow-sm",
          },
          [
            row({ gap: 3, align: "center", justify: "between" }, [
              column({ gap: 1 }, [
                heading("MaternalGuard Morning Huddle", 2),
                muted(
                  "Cohort triage across pregnant patients. All proposals are draft and require clinician review before any action.",
                ),
              ]),
              badge(`${panel.length} patients`, "secondary"),
            ]),
          ],
        );

        const metricsGrid = grid({ minColumnWidth: "200px", gap: 3 }, [
          metric({ label: "Red (today)", value: String(red) }),
          metric({ label: "Yellow (within 48h)", value: String(yel) }),
          metric({ label: "Green (routine)", value: String(grn) }),
        ]);

        const patientCards = panel.map((p, pIdx): PrefabNode => {
          const inner: PrefabNode[] = [];

          if (p.urgency.patternFlags.length) {
            inner.push(
              row(
                { gap: 2 },
                p.urgency.patternFlags.map((pf) => badge(pf, "destructive")),
              ),
            );
          }

          if (p.urgency.signals.length) {
            inner.push(text("Contributing signals:", { bold: true }));
            for (const s of p.urgency.signals.slice(0, 6)) {
              inner.push(muted(`• ${s.finding}`));
            }
          }

          if (p.tasks.length) {
            inner.push(separator());
            inner.push(text(`Draft tasks (${p.tasks.length})`, { bold: true }));

            for (const [tIdx, task] of p.tasks.entries()) {
              const tid = task.id ?? "";
              const status = task.status ?? "";
              const desc = (task.description ?? "").split("\n")[0].slice(0, 120);
              const prefix = `t_${p.id.slice(0, 8)}_${pIdx}_${tIdx}`;

              const editFields = grid({ minColumnWidth: "220px", gap: 2 }, [
                column({ gap: 1 }, [
                  label("Owner"),
                  input({
                    name: `${prefix}_owner`,
                    value: task.owner?.display ?? "",
                  }),
                ]),
                column({ gap: 1 }, [
                  label("Due (hours from now)"),
                  input({
                    name: `${prefix}_due_hours`,
                    value: _dueHoursFromTask(task),
                    inputType: "number",
                  }),
                ]),
                column({ gap: 1 }, [
                  label("Clinician note"),
                  input({ name: `${prefix}_note`, value: "" }),
                ]),
              ]);

              const buttonsRow = row({ gap: 2 }, [
                button("Approve", {
                  variant: "default",
                  onClick: callTool({
                    tool: "UpdateMaternalAction",
                    arguments: {
                      action: "approve",
                      taskId: tid,
                      clinicianNote: `{{ ${prefix}_note }}`,
                    },
                    onSuccess: [
                      showToast({
                        message: "Approved",
                        description: "Task moved to accepted.",
                      }),
                    ],
                    onError: showToast({
                      message: "Approve failed",
                      description: "See server logs.",
                      variant: "error",
                    }),
                  }),
                }),
                button("Reject", {
                  variant: "outline",
                  onClick: callTool({
                    tool: "UpdateMaternalAction",
                    arguments: {
                      action: "reject",
                      taskId: tid,
                      reason: `{{ ${prefix}_note }}`,
                    },
                    onSuccess: [
                      showToast({
                        message: "Rejected",
                        description: "Task closed with reason.",
                      }),
                    ],
                    onError: showToast({
                      message: "Reject failed",
                      description: "See server logs.",
                      variant: "error",
                    }),
                  }),
                }),
                button("Save edits", {
                  variant: "secondary",
                  onClick: callTool({
                    tool: "UpdateMaternalAction",
                    arguments: {
                      action: "edit-coordination",
                      taskId: tid,
                      ownerDisplay: `{{ ${prefix}_owner }}`,
                      dueWithinHours: `{{ ${prefix}_due_hours }}`,
                      clinicianNote: `{{ ${prefix}_note }}`,
                    },
                    onSuccess: [
                      showToast({
                        message: "Saved",
                        description: "Coordination metadata updated.",
                      }),
                    ],
                    onError: showToast({
                      message: "Save failed",
                      description: "See server logs.",
                      variant: "error",
                    }),
                  }),
                }),
              ]);

              inner.push(
                column(
                  {
                    gap: 2,
                    cssClass:
                      "rounded-md border border-slate-200 p-3 bg-slate-50",
                  },
                  [
                    row({ gap: 2, align: "center", justify: "between" }, [
                      text(desc, { bold: true }),
                      badge(status, "secondary"),
                    ]),
                    editFields,
                    status === "requested" ? buttonsRow : muted(`Status: ${status}`),
                  ],
                ),
              );
            }
          }

          if (p.flags.length) {
            inner.push(separator());
            inner.push(text(`Draft flags (${p.flags.length})`, { bold: true }));
            for (const [fIdx, f] of p.flags.entries()) {
              const fid = f.id ?? "";
              const fst = f.status ?? "";
              const finding = f.code?.text ?? "(no finding)";
              const prefix = `f_${p.id.slice(0, 8)}_${pIdx}_${fIdx}`;

              const flagButtons =
                fst === "inactive"
                  ? row({ gap: 2 }, [
                      button("Activate", {
                        variant: "default",
                        onClick: callTool({
                          tool: "UpdateMaternalAction",
                          arguments: { action: "activate-flag", flagId: fid },
                          onSuccess: [
                            showToast({
                              message: "Activated",
                              description: "Flag is now visible.",
                            }),
                          ],
                          onError: showToast({
                            message: "Activate failed",
                            description: "See server logs.",
                            variant: "error",
                          }),
                        }),
                      }),
                      button("Dismiss", {
                        variant: "outline",
                        onClick: callTool({
                          tool: "UpdateMaternalAction",
                          arguments: {
                            action: "dismiss-flag",
                            flagId: fid,
                            reason: `{{ ${prefix}_reason }}`,
                          },
                          onSuccess: [
                            showToast({
                              message: "Dismissed",
                              description: "Flag closed.",
                            }),
                          ],
                          onError: showToast({
                            message: "Dismiss failed",
                            description: "See server logs.",
                            variant: "error",
                          }),
                        }),
                      }),
                    ])
                  : muted(`Status: ${fst}`);

              inner.push(
                column(
                  {
                    gap: 2,
                    cssClass:
                      "rounded-md border border-slate-200 p-3 bg-slate-50",
                  },
                  [
                    row({ gap: 2, align: "center", justify: "between" }, [
                      text(finding, { bold: true }),
                      badge(fst, "secondary"),
                    ]),
                    fst === "inactive"
                      ? column({ gap: 1 }, [
                          label("Reason if dismissing"),
                          input({ name: `${prefix}_reason`, value: "" }),
                        ])
                      : muted(""),
                    flagButtons,
                  ],
                ),
              );
            }
          }

          return card({ cssClass: "border-slate-200 bg-white" }, [
            cardHeader({}, [
              row({ gap: 2, align: "center", justify: "between" }, [
                column({ gap: 1 }, [
                  cardTitle(p.display),
                  muted(
                    `Score: ${p.urgency.score} | Signals: ${p.urgency.signals.length} | Drafts: ${p.tasks.length} task(s), ${p.flags.length} flag(s)`,
                  ),
                ]),
                badge(p.urgency.band, bandToBadgeVariant(p.urgency.band)),
              ]),
            ]),
            cardContent({}, [column({ gap: 3 }, inner)]),
          ]);
        });

        const emptyState =
          panel.length === 0
            ? alert({ variant: "warning" }, [
                alertTitle("No patients in cohort"),
                alertDescription(
                  "Set MATERNALGUARD_BUNDLED_PATIENT_IDS in your Node server .env or select a patient.",
                ),
              ])
            : null;

        const footer = muted(
          "Decision support only. Clinician review required before any action. MaternalGuard does not place orders, prescribe, or contact patients.",
        );

        const view = column(
          { gap: 5, cssClass: "p-6 max-w-5xl mx-auto" },
          [
            headerCard,
            metricsGrid,
            ...(emptyState ? [emptyState] : patientCards),
            separator(),
            footer,
          ],
        );

        const app = prefabApp({
          title: "MaternalGuard Morning Huddle",
          cssClass: "bg-slate-50 text-slate-950",
          view,
        });

        return prefabAppToCallToolResult(app);
      },
    );
  }
}

export const OpenMaternalDashboardToolInstance = new OpenMaternalDashboardTool();
