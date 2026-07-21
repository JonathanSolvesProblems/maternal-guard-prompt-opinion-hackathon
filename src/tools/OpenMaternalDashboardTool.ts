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
import { pregnancyContext } from "../clinical/pregnancy";
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
  // `tasks` and `flags` are DRAFTS only (Task.status=requested,
  // Flag.status=inactive) — actionable in the dashboard.
  tasks: fhirR4.Task[];
  flags: fhirR4.Flag[];
  // `resolvedTasks` and `resolvedFlags` are recently-actioned items
  // (accepted / rejected / active / entered-in-error), capped at the 5
  // most-recent per axis. They render in a "Recently actioned" section
  // so the clinician can SEE where a just-approved task went instead of
  // trusting the toast and wondering.
  resolvedTasks: fhirR4.Task[];
  resolvedFlags: fhirR4.Flag[];
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

              // Guard: only score patients who are actually pregnant and
              // female. Without this, the classifier will happily emit a
              // RED/YELLOW/GREEN band on male or non-pregnant patients
              // whose IDs land in the cohort — a silent safety issue that
              // undermines the "clinician trust" thesis.
              const preg = pregnancyContext(patient, conditions ?? undefined);
              if (!preg.applicable) {
                console.log(
                  `[OpenMaternalDashboard] skipping patient ${pid}: ${preg.reason}`,
                );
                return null;
              }

              const urgency = classifyUrgency({
                gestationalAgeWeeks: preg.gestationalAgeWeeks,
                bpReadings: bp,
                labReadings: labs,
              });

              // Split MaternalGuard-tagged Tasks and Flags by lifecycle:
              //   drafts     - actionable in the dashboard (with buttons)
              //   resolved   - historical, shown in a muted
              //                "Recently actioned" section so the
              //                clinician sees WHERE a just-approved
              //                task went instead of it silently
              //                vanishing.
              // Resolved lists are capped at 5 most-recent per axis,
              // sorted by lastModified (falls back to authoredOn for
              // Tasks / period.start for Flags) descending.
              // Some fhirR4 date fields are typed `string | Date` in
              // @smile-cdr/fhirts. Coerce to ISO string for sort keys.
              const asIso = (v: string | Date | undefined): string => {
                if (!v) return "";
                if (typeof v === "string") return v;
                return v.toISOString();
              };
              const allMgTasks = (tasks?.entry ?? [])
                .map((e) => e.resource as fhirR4.Task)
                .filter(isMaternalGuardTask);
              const mgTasks = allMgTasks.filter((t) => t.status === "requested");
              const resolvedTasks = allMgTasks
                .filter((t) => t.status && t.status !== "requested")
                .sort((a, b) => {
                  const ak = asIso(a.lastModified) || asIso(a.authoredOn);
                  const bk = asIso(b.lastModified) || asIso(b.authoredOn);
                  return bk.localeCompare(ak);
                })
                .slice(0, 5);
              const allMgFlags = (flags?.entry ?? [])
                .map((e) => e.resource as fhirR4.Flag)
                .filter(isMaternalGuardFlag);
              const mgFlags = allMgFlags.filter((f) => f.status === "inactive");
              const resolvedFlags = allMgFlags
                .filter((f) => f.status && f.status !== "inactive")
                .sort((a, b) => {
                  const ak = asIso(a.period?.start);
                  const bk = asIso(b.period?.start);
                  return bk.localeCompare(ak);
                })
                .slice(0, 5);

              const family = patient.name?.[0]?.family ?? "";
              const given = (patient.name?.[0]?.given ?? []).join(" ");
              const display = `${family}${given ? ", " + given : ""}` || pid;

              return {
                id: pid,
                display,
                urgency,
                tasks: mgTasks,
                flags: mgFlags,
                resolvedTasks,
                resolvedFlags,
              };
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

          // Dashboard tasks: buttons-only. Approve is one click — no
          // Clinician-note field to fill in. Reject is one click — the
          // server records a default reason ("Rejected by clinician
          // during huddle review") so the audit trail is populated
          // without asking the clinician to type. Save-edits is a
          // deliberate detour; it belongs behind an explicit Edit
          // affordance, not on the primary triage card. This matches
          // Pawan's "from 1000 clicks to copilots" thesis: the whole
          // reason the dashboard exists is to remove typing.
          if (p.tasks.length) {
            inner.push(separator());
            inner.push(text(`Draft tasks (${p.tasks.length})`, { bold: true }));

            for (const task of p.tasks) {
              const tid = task.id ?? "";
              const status = task.status ?? "";
              const desc = (task.description ?? "").split("\n")[0].slice(0, 120);
              const owner = task.owner?.display;
              const dueEnd = task.restriction?.period?.end;

              const metaBits: string[] = [];
              if (owner) metaBits.push(`Owner: ${owner}`);
              if (dueEnd) {
                const dueStr = typeof dueEnd === "string" ? dueEnd : dueEnd.toISOString();
                metaBits.push(`Due: ${dueStr.slice(0, 16).replace("T", " ")}`);
              }

              // Each button's onSuccess chain fires two actions:
              //   1) the confirmation toast (visual "done" cue)
              //   2) an auto re-invocation of OpenMaternalDashboard so the
              //      just-actioned draft disappears from the huddle (the
              //      draft-only filter hides accepted/rejected tasks).
              // The clinician SEES the state change instead of having to
              // trust the toast and remember to re-open the dashboard.
              const refreshDashboard = callTool({
                tool: "OpenMaternalDashboard",
                arguments: { mode: "default" },
              });
              const buttonsRow = row({ gap: 2 }, [
                button("Approve", {
                  variant: "default",
                  onClick: callTool({
                    tool: "UpdateMaternalAction",
                    arguments: { action: "approve", taskId: tid },
                    onSuccess: [
                      showToast({
                        message: "Approved",
                        description: "Task moved to accepted. See it under Recently actioned in the refreshed dashboard below.",
                      }),
                      refreshDashboard,
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
                    arguments: { action: "reject", taskId: tid },
                    onSuccess: [
                      showToast({
                        message: "Rejected",
                        description: "Task rejected with default audit reason. See it under Recently actioned in the refreshed dashboard below.",
                      }),
                      refreshDashboard,
                    ],
                    onError: showToast({
                      message: "Reject failed",
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
                    metaBits.length
                      ? muted(metaBits.join("  ·  "))
                      : muted(""),
                    status === "requested" ? buttonsRow : muted(`Status: ${status}`),
                  ],
                ),
              );
            }
          }

          // Flags: same rule. Activate is one click. Dismiss is one
          // click; server supplies default reason "Dismissed by
          // clinician during huddle review" so the audit is populated.
          if (p.flags.length) {
            inner.push(separator());
            inner.push(text(`Draft flags (${p.flags.length})`, { bold: true }));
            for (const f of p.flags) {
              const fid = f.id ?? "";
              const fst = f.status ?? "";
              const finding = f.code?.text ?? "(no finding)";

              // Same refresh-on-success pattern as task buttons: dashboard
              // re-invokes itself after the state transition so the
              // just-actioned flag disappears from the huddle.
              const refreshFlagDashboard = callTool({
                tool: "OpenMaternalDashboard",
                arguments: { mode: "default" },
              });
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
                              description: "Flag activated on the chart. See it under Recently actioned in the refreshed dashboard below.",
                            }),
                            refreshFlagDashboard,
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
                          arguments: { action: "dismiss-flag", flagId: fid },
                          onSuccess: [
                            showToast({
                              message: "Dismissed",
                              description: "Flag dismissed with default audit reason. See it under Recently actioned in the refreshed dashboard below.",
                            }),
                            refreshFlagDashboard,
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
                    flagButtons,
                  ],
                ),
              );
            }
          }

          // Recently actioned: the muted "where did it go" section.
          // Shows accepted / rejected Tasks and active / dismissed Flags
          // so the clinician sees the destination of the last few
          // decisions instead of items silently disappearing after a
          // button click. Capped at 5 per axis in the sort/slice above.
          if (p.resolvedTasks.length || p.resolvedFlags.length) {
            inner.push(separator());
            inner.push(
              text(
                `Recently actioned (${p.resolvedTasks.length + p.resolvedFlags.length})`,
                { bold: true },
              ),
            );
            for (const task of p.resolvedTasks) {
              const desc = (task.description ?? "").split("\n")[0].slice(0, 100);
              const status = task.status ?? "unknown";
              const bv: BadgeVariant =
                status === "accepted" ? "success" : "secondary";
              inner.push(
                row(
                  {
                    gap: 2,
                    align: "center",
                    justify: "between",
                    cssClass:
                      "rounded-md border border-slate-100 p-2 bg-slate-50",
                  },
                  [muted(desc), badge(status, bv)],
                ),
              );
            }
            for (const f of p.resolvedFlags) {
              const finding = f.code?.text ?? "(no finding)";
              const status = f.status ?? "unknown";
              const bv: BadgeVariant =
                status === "active" ? "success" : "secondary";
              inner.push(
                row(
                  {
                    gap: 2,
                    align: "center",
                    justify: "between",
                    cssClass:
                      "rounded-md border border-slate-100 p-2 bg-slate-50",
                  },
                  [muted(finding), badge(status, bv)],
                ),
              );
            }
          }

          // Per-patient empty state. Only show the seed-prompt hint when
          // the patient has ZERO drafts AND ZERO recently-actioned items
          // (a truly untouched chart). If they have resolved items but no
          // drafts, the Recently actioned section above communicates the
          // state and the "No draft actions yet" alert would be noise.
          if (
            p.tasks.length === 0 &&
            p.flags.length === 0 &&
            p.resolvedTasks.length === 0 &&
            p.resolvedFlags.length === 0
          ) {
            inner.push(separator());
            inner.push(
              alert({ variant: "default" }, [
                alertTitle("No draft actions yet"),
                alertDescription(
                  'Ask the agent: "Assess maternal risk for this patient and draft the appropriate follow-up actions." The agent will call ProposeMaternalAction and any drafts will appear here for one-click Approve / Reject.',
                ),
              ]),
            );
          }

          return card({ cssClass: "border-slate-200 bg-white overflow-hidden" }, [
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
          // Iframe width in Prompt Opinion's chat panel is narrower than
          // Tailwind's max-w-5xl (1024px). Drop the outer max-width and
          // clip any accidental horizontal overflow so no scroll bar
          // surfaces at the bottom of the card.
          { gap: 5, cssClass: "p-4 max-w-full overflow-x-hidden" },
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
