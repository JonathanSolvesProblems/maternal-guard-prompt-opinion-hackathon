"""
MaternalGuard UI sidecar.

A small Python MCP server that renders an interactive morning-huddle dashboard
inside Prompt Opinion using the prefab-ui library. It does not duplicate any
clinical logic. It reads patient data directly from the workspace FHIR store
(via the SHARP context the platform forwards on every request) and routes user
button clicks back to the existing Node MCP server's tools (ProposeMaternalAction,
UpdateMaternalAction, ListMaternalActions).

Two MCP servers are expected to be attached to the same Prompt Opinion agent:

    1. MaternalGuard (Node, Express): 9 tools covering data, write-back, list,
       update, and panel scan. Stays in TypeScript.
    2. MaternalGuard UI (this Python sidecar): one tool, OpenMaternalDashboard,
       that returns a PrefabApp. Buttons inside the PrefabApp use CallTool
       actions to invoke the Node server's tools by name.

Run locally:
    pip install -r requirements.txt
    python maternal_dashboard_server.py

Environment variables:
    PORT (default 5001)
    MCP_API_KEY (optional; when set, callers must send matching X-API-Key)
    MATERNALGUARD_BUNDLED_PATIENT_IDS (comma-separated FHIR Patient IDs)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_request

from prefab_ui.app import PrefabApp
from prefab_ui.actions import SetState, ShowToast
from prefab_ui.actions.mcp import CallTool
from prefab_ui.components import (
    Alert,
    AlertDescription,
    AlertTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Column,
    Grid,
    Heading,
    Input,
    Label,
    Metric,
    Muted,
    Row,
    Separator,
    Text,
)

# ─── SHARP header constants ─────────────────────────────────────────────────
SHARP_FHIR_URL_HEADER = "x-fhir-server-url"
SHARP_FHIR_TOKEN_HEADER = "x-fhir-access-token"
SHARP_PATIENT_ID_HEADER = "x-patient-id"

# ─── LOINC codes used by the deterministic urgency classifier ──────────────
LOINC_AST = ("1920-8", "30239-8")
LOINC_PLATELETS = ("777-3", "26515-7")
LOINC_URIC_ACID = ("3084-1", "14933-6")
LOINC_PROTEINURIA = ("2888-6", "32209-9", "2890-2", "34366-5")
LOINC_FASTING_GLUCOSE = ("1558-6", "1554-5")
LOINC_BP_PANEL = "85354-9"
LOINC_BP_SYSTOLIC = "8480-6"
LOINC_BP_DIASTOLIC = "8462-4"

# ─── FastMCP server initialization ──────────────────────────────────────────
mcp = FastMCP(
    name="MaternalGuard UI",
    instructions=(
        "Renders the MaternalGuard morning-huddle dashboard inside Prompt Opinion. "
        "Use the OpenMaternalDashboard tool when the user asks for a cohort view, "
        "morning huddle, panel triage, or wants to see and act on draft maternal actions."
    ),
)


# ─── FHIR access helpers ────────────────────────────────────────────────────
def _read_fhir_context() -> Dict[str, str]:
    """Extract SHARP headers from the inbound HTTP request."""
    try:
        request = get_http_request()
        h = request.headers
        return {
            "fhir_url": h.get(SHARP_FHIR_URL_HEADER, "").strip(),
            "fhir_token": h.get(SHARP_FHIR_TOKEN_HEADER, "").strip(),
            "patient_id": h.get(SHARP_PATIENT_ID_HEADER, "").strip(),
        }
    except Exception:
        return {"fhir_url": "", "fhir_token": "", "patient_id": ""}


def _fhir_get(url: str, token: str, path: str) -> Optional[Dict[str, Any]]:
    """GET against the FHIR endpoint. Returns parsed JSON, or None on 404."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        r = httpx.get(f"{url.rstrip('/')}/{path}", headers=headers, timeout=30.0)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        # Surface in the UI rather than crashing.
        return {"_error": str(e)}


# ─── Deterministic urgency classification ───────────────────────────────────
# Mirrors src/clinical/urgency-classifier.ts in the Node server.
def _classify_urgency(
    bp_readings: List[Dict[str, Any]], lab_readings: List[Dict[str, Any]]
) -> Dict[str, Any]:
    signals: List[Dict[str, Any]] = []
    pattern_flags: List[str] = []
    score = 0

    bp_sorted = sorted(bp_readings, key=lambda b: b.get("date", ""))
    bp_rising = False
    if bp_sorted:
        latest = bp_sorted[-1]
        sys_v = latest.get("systolic")
        dia_v = latest.get("diastolic")
        if isinstance(sys_v, (int, float)) and isinstance(dia_v, (int, float)):
            if sys_v >= 160 or dia_v >= 110:
                signals.append({"axis": "blood-pressure", "finding": f"Severe-range BP {sys_v}/{dia_v}", "severity": "severe"})
                score += 60
            elif sys_v >= 140 or dia_v >= 90:
                signals.append({"axis": "blood-pressure", "finding": f"Hypertensive BP {sys_v}/{dia_v}", "severity": "moderate"})
                score += 25
        if len(bp_sorted) >= 2:
            sys_series = [b.get("systolic") for b in bp_sorted if isinstance(b.get("systolic"), (int, float))]
            if len(sys_series) >= 2 and sys_series[-1] - sys_series[0] >= 10:
                bp_rising = True
                signals.append({"axis": "blood-pressure", "finding": f"Systolic rising {sys_series[0]} -> {sys_series[-1]}", "severity": "moderate"})
                score += 15

    def _series(codes) -> List[Dict[str, Any]]:
        out = [l for l in lab_readings if any(l.get("code", "").startswith(c) for c in codes)]
        out.sort(key=lambda l: l.get("date", ""))
        return out

    ast_series = _series(LOINC_AST)
    ast_rising = False
    if ast_series:
        latest = ast_series[-1].get("value")
        if isinstance(latest, (int, float)):
            if latest >= 70:
                signals.append({"axis": "ast", "finding": f"AST severely elevated ({latest})", "severity": "severe"})
                score += 50
            elif latest >= 40:
                signals.append({"axis": "ast", "finding": f"AST elevated ({latest})", "severity": "moderate"})
                score += 20
        if len(ast_series) >= 2:
            vals = [l.get("value") for l in ast_series if isinstance(l.get("value"), (int, float))]
            if len(vals) >= 2 and vals[-1] - vals[0] >= 10:
                ast_rising = True
                signals.append({"axis": "ast", "finding": f"AST rising {vals[0]} -> {vals[-1]}", "severity": "moderate"})
                score += 15

    plt_series = _series(LOINC_PLATELETS)
    plt_falling = False
    if plt_series:
        latest = plt_series[-1].get("value")
        if isinstance(latest, (int, float)):
            if latest < 100:
                signals.append({"axis": "platelets", "finding": f"Platelets severely low ({latest})", "severity": "severe"})
                score += 60
            elif latest < 150:
                signals.append({"axis": "platelets", "finding": f"Platelets below normal ({latest})", "severity": "moderate"})
                score += 20
        if len(plt_series) >= 2:
            vals = [l.get("value") for l in plt_series if isinstance(l.get("value"), (int, float))]
            if len(vals) >= 2 and vals[0] - vals[-1] >= 15:
                plt_falling = True
                signals.append({"axis": "platelets", "finding": f"Platelets falling {vals[0]} -> {vals[-1]}", "severity": "moderate"})
                score += 15

    prot_series = _series(LOINC_PROTEINURIA)
    prot_rising = False
    if prot_series:
        latest = prot_series[-1].get("value")
        if isinstance(latest, (int, float)) and latest >= 30:
            signals.append({"axis": "proteinuria", "finding": f"Proteinuria present ({latest})", "severity": "moderate"})
            score += 20
        if len(prot_series) >= 2:
            vals = [l.get("value") for l in prot_series if isinstance(l.get("value"), (int, float))]
            if len(vals) >= 2 and vals[-1] > vals[0]:
                prot_rising = True
                signals.append({"axis": "proteinuria", "finding": "Proteinuria trending upward", "severity": "mild"})
                score += 10

    uric_series = _series(LOINC_URIC_ACID)
    if uric_series:
        latest = uric_series[-1].get("value")
        if isinstance(latest, (int, float)) and latest >= 6.0:
            signals.append({"axis": "uric-acid", "finding": f"Uric acid elevated ({latest})", "severity": "moderate"})
            score += 15

    glu_series = _series(LOINC_FASTING_GLUCOSE)
    if glu_series:
        latest = glu_series[-1].get("value")
        if isinstance(latest, (int, float)) and latest >= 92:
            signals.append({"axis": "glucose", "finding": f"Fasting glucose >= IADPSG threshold ({latest})", "severity": "mild"})
            score += 10

    if ast_rising and plt_falling and (bp_rising or prot_rising):
        pattern_flags.append("HELLP-evolution")
        score += 40

    if score >= 80 or "HELLP-evolution" in pattern_flags:
        band = "RED"
    elif score >= 30:
        band = "YELLOW"
    else:
        band = "GREEN"

    return {"band": band, "score": score, "signals": signals, "patternFlags": pattern_flags}


# ─── Per-patient cohort fetcher ─────────────────────────────────────────────
def _bundled_patient_ids() -> List[str]:
    raw = os.getenv("MATERNALGUARD_BUNDLED_PATIENT_IDS", "")
    return [p.strip() for p in raw.split(",") if p.strip()]


def _is_maternalguard_task(task: Dict[str, Any]) -> bool:
    for c in (task.get("code", {}).get("coding") or []):
        if (
            c.get("system") == "http://maternalguard.local/task-codes"
            and c.get("code") == "maternal-risk-action"
        ):
            return True
    return False


def _is_maternalguard_flag(flag: Dict[str, Any]) -> bool:
    for cat in (flag.get("category") or []):
        for c in (cat.get("coding") or []):
            if c.get("system") == "http://maternalguard.local/flag-categories":
                return True
    return False


def _gather_panel(ctx: Dict[str, str]) -> List[Dict[str, Any]]:
    bundled = _bundled_patient_ids()
    # If the selected patient is not in the bundled list, include them too so the
    # dashboard works even when the env var is not set.
    if ctx.get("patient_id") and ctx["patient_id"] not in bundled:
        bundled = [ctx["patient_id"], *bundled]

    out: List[Dict[str, Any]] = []
    for pid in bundled:
        patient = _fhir_get(ctx["fhir_url"], ctx["fhir_token"], f"Patient/{pid}")
        if not patient or patient.get("_error"):
            continue
        obs_bundle = _fhir_get(ctx["fhir_url"], ctx["fhir_token"], f"Observation?patient={pid}&_count=100&_sort=-date") or {}
        task_bundle = _fhir_get(ctx["fhir_url"], ctx["fhir_token"], f"Task?subject=Patient/{pid}&_count=20") or {}
        flag_bundle = _fhir_get(ctx["fhir_url"], ctx["fhir_token"], f"Flag?subject=Patient/{pid}&_count=20") or {}

        bp_readings: List[Dict[str, Any]] = []
        lab_readings: List[Dict[str, Any]] = []
        for entry in (obs_bundle.get("entry") or []):
            obs = entry.get("resource") or {}
            code = ((obs.get("code") or {}).get("coding") or [{}])[0].get("code", "")
            date = obs.get("effectiveDateTime") or obs.get("issued") or ""
            if code == LOINC_BP_PANEL:
                sys_v = None
                dia_v = None
                for comp in obs.get("component") or []:
                    cc = ((comp.get("code") or {}).get("coding") or [{}])[0].get("code", "")
                    val = (comp.get("valueQuantity") or {}).get("value")
                    if cc == LOINC_BP_SYSTOLIC:
                        sys_v = val
                    elif cc == LOINC_BP_DIASTOLIC:
                        dia_v = val
                bp_readings.append({"date": date, "systolic": sys_v, "diastolic": dia_v})
            else:
                vq = obs.get("valueQuantity") or {}
                v = vq.get("value")
                if isinstance(v, (int, float)):
                    lab_readings.append({"code": code, "value": v, "unit": vq.get("unit"), "date": date})

        urgency = _classify_urgency(bp_readings, lab_readings)

        name_obj = (patient.get("name") or [{}])[0]
        family = name_obj.get("family", "") or ""
        given = " ".join(name_obj.get("given") or []) if isinstance(name_obj.get("given"), list) else ""
        display_name = (f"{family}, {given}".strip(", ")) or pid

        mg_tasks: List[Dict[str, Any]] = []
        for e in (task_bundle.get("entry") or []):
            t = e.get("resource") or {}
            if _is_maternalguard_task(t):
                mg_tasks.append(t)

        mg_flags: List[Dict[str, Any]] = []
        for e in (flag_bundle.get("entry") or []):
            f = e.get("resource") or {}
            if _is_maternalguard_flag(f):
                mg_flags.append(f)

        out.append(
            {
                "id": pid,
                "name": display_name,
                "urgency": urgency,
                "tasks": mg_tasks,
                "flags": mg_flags,
            }
        )

    out.sort(key=lambda p: p.get("urgency", {}).get("score", 0), reverse=True)
    return out


def _band_variant(band: str) -> str:
    return {"RED": "destructive", "YELLOW": "warning", "GREEN": "success"}.get(band, "secondary")


# ─── The single dashboard tool ──────────────────────────────────────────────
@mcp.tool(
    name="OpenMaternalDashboard",
    description=(
        "Renders the MaternalGuard interactive morning-huddle dashboard inside the chat. "
        "Shows the ranked cohort with RED/YELLOW/GREEN urgency bands, contributing signals "
        "(HELLP-evolution, hypertensive BP, rising AST, falling platelets, proteinuria), "
        "and per-patient draft Tasks with Approve/Reject buttons and editable coordination fields. "
        "Buttons route back to the MaternalGuard MCP server (ProposeMaternalAction, "
        "UpdateMaternalAction) to persist changes as FHIR resources. "
        "Use this when the user asks for 'morning huddle', 'cohort dashboard', "
        "'triage queue', 'panel view', 'show me the queue', or 'who needs attention'."
    ),
)
def open_maternal_dashboard() -> PrefabApp:
    ctx = _read_fhir_context()

    if not ctx.get("fhir_url"):
        with PrefabApp(
            title="MaternalGuard Morning Huddle",
            css_class="bg-slate-50 text-slate-950",
        ) as app:
            with Column(gap=4, css_class="p-6"):
                Heading("MaternalGuard Morning Huddle")
                with Alert(variant="warning"):
                    AlertTitle("FHIR context missing")
                    AlertDescription(
                        "This dashboard requires SHARP headers (X-FHIR-Server-URL, "
                        "X-FHIR-Access-Token). Ensure the MaternalGuard MCP server is "
                        "attached to the agent and Patient Context is enabled."
                    )
        return app

    patients = _gather_panel(ctx)
    red_count = sum(1 for p in patients if p["urgency"]["band"] == "RED")
    yel_count = sum(1 for p in patients if p["urgency"]["band"] == "YELLOW")
    grn_count = sum(1 for p in patients if p["urgency"]["band"] == "GREEN")

    with PrefabApp(
        title="MaternalGuard Morning Huddle",
        css_class="bg-slate-50 text-slate-950",
    ) as app:
        with Column(gap=5, css_class="p-6 max-w-5xl mx-auto"):
            # ── Header ────────────────────────────────────────────────────
            with Column(gap=3, css_class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"):
                with Row(gap=3, align="center", justify="between"):
                    with Column(gap=1):
                        Heading("MaternalGuard Morning Huddle")
                        Muted(
                            "Cohort triage across pregnant patients. All proposals are "
                            "draft and require clinician review before any action."
                        )
                    Badge(f"{len(patients)} patients", variant="secondary")

            # ── Metrics grid ──────────────────────────────────────────────
            with Grid(minColumnWidth="200px", gap=3):
                Metric(label="Red (today)", value=str(red_count))
                Metric(label="Yellow (within 48h)", value=str(yel_count))
                Metric(label="Green (routine)", value=str(grn_count))

            # ── Per-patient cards ─────────────────────────────────────────
            if not patients:
                with Alert(variant="default"):
                    AlertTitle("No patients in the bundled cohort")
                    AlertDescription(
                        "Set MATERNALGUARD_BUNDLED_PATIENT_IDS or select a patient with "
                        "MaternalGuard MCP attached."
                    )
            else:
                for patient in patients:
                    urgency = patient["urgency"]
                    band = urgency["band"]
                    signals = urgency["signals"]
                    pattern_flags = urgency["patternFlags"]

                    with Card(css_class="border-slate-200 bg-white"):
                        with CardHeader():
                            with Row(gap=2, align="center", justify="between"):
                                with Column(gap=1):
                                    CardTitle(patient["name"])
                                    Muted(
                                        f"Score: {urgency['score']} | "
                                        f"Signals: {len(signals)} | "
                                        f"Drafts: {len(patient['tasks'])} task(s), "
                                        f"{len(patient['flags'])} flag(s)"
                                    )
                                Badge(band, variant=_band_variant(band))

                        with CardContent():
                            with Column(gap=3):
                                if pattern_flags:
                                    with Row(gap=2):
                                        for pf in pattern_flags:
                                            Badge(pf, variant="destructive")

                                if signals:
                                    Text("Contributing signals:", bold=True)
                                    for s in signals[:6]:
                                        Muted(f"• {s.get('finding', '')}")

                                # ── Draft tasks ───────────────────────────
                                tasks = patient["tasks"]
                                if tasks:
                                    Separator()
                                    Text(f"Draft tasks ({len(tasks)})", bold=True)
                                    for idx, task in enumerate(tasks):
                                        task_id = task.get("id", "")
                                        status = task.get("status", "")
                                        desc_first_line = (task.get("description") or "").split("\n")[0][:120]
                                        prefix = f"t_{patient['id'][:8]}_{idx}"

                                        with Column(gap=2, css_class="rounded-md border border-slate-200 p-3 bg-slate-50"):
                                            with Row(gap=2, align="center", justify="between"):
                                                Text(desc_first_line, bold=True)
                                                Badge(status, variant="secondary")

                                            with Grid(minColumnWidth="220px", gap=2):
                                                with Column(gap=1):
                                                    Label("Owner")
                                                    Input(
                                                        name=f"{prefix}_owner",
                                                        value=(task.get("owner") or {}).get("display") or "",
                                                    )
                                                with Column(gap=1):
                                                    Label("Due (hours from now)")
                                                    Input(
                                                        name=f"{prefix}_due_hours",
                                                        value="24",
                                                        type="number",
                                                    )
                                                with Column(gap=1):
                                                    Label("Clinician note")
                                                    Input(
                                                        name=f"{prefix}_note",
                                                        value="",
                                                    )

                                            # Status-conditional buttons.
                                            with Row(gap=2):
                                                if status == "requested":
                                                    approve_action = CallTool(
                                                        "UpdateMaternalAction",
                                                        arguments={
                                                            "action": "approve",
                                                            "taskId": task_id,
                                                            "clinicianNote": f"{{{{ {prefix}_note }}}}",
                                                        },
                                                        on_success=[
                                                            ShowToast(
                                                                {
                                                                    "title": "Approved",
                                                                    "description": "Task moved to accepted.",
                                                                }
                                                            )
                                                        ],
                                                        on_error=ShowToast(
                                                            {
                                                                "title": "Approve failed",
                                                                "description": "See server logs.",
                                                                "variant": "destructive",
                                                            }
                                                        ),
                                                    )
                                                    reject_action = CallTool(
                                                        "UpdateMaternalAction",
                                                        arguments={
                                                            "action": "reject",
                                                            "taskId": task_id,
                                                            "reason": f"{{{{ {prefix}_note }}}}",
                                                        },
                                                        on_success=[
                                                            ShowToast(
                                                                {
                                                                    "title": "Rejected",
                                                                    "description": "Task closed with reason.",
                                                                }
                                                            )
                                                        ],
                                                        on_error=ShowToast(
                                                            {
                                                                "title": "Reject failed",
                                                                "description": "See server logs.",
                                                                "variant": "destructive",
                                                            }
                                                        ),
                                                    )
                                                    edit_action = CallTool(
                                                        "UpdateMaternalAction",
                                                        arguments={
                                                            "action": "edit-coordination",
                                                            "taskId": task_id,
                                                            "ownerDisplay": f"{{{{ {prefix}_owner }}}}",
                                                            "dueWithinHours": f"{{{{ {prefix}_due_hours }}}}",
                                                            "clinicianNote": f"{{{{ {prefix}_note }}}}",
                                                        },
                                                        on_success=[
                                                            ShowToast(
                                                                {
                                                                    "title": "Saved",
                                                                    "description": "Coordination metadata updated.",
                                                                }
                                                            )
                                                        ],
                                                        on_error=ShowToast(
                                                            {
                                                                "title": "Save failed",
                                                                "description": "See server logs.",
                                                                "variant": "destructive",
                                                            }
                                                        ),
                                                    )
                                                    Button("Approve", variant="default", on_click=approve_action)
                                                    Button("Reject", variant="outline", on_click=reject_action)
                                                    Button("Save edits", variant="secondary", on_click=edit_action)
                                                else:
                                                    Muted(f"Status: {status} (no further actions)")

                                # ── Draft flags ───────────────────────────
                                flags = patient["flags"]
                                if flags:
                                    Separator()
                                    Text(f"Draft flags ({len(flags)})", bold=True)
                                    for fidx, flag in enumerate(flags):
                                        flag_id = flag.get("id", "")
                                        f_status = flag.get("status", "")
                                        finding = (flag.get("code") or {}).get("text") or "(no finding text)"
                                        f_prefix = f"f_{patient['id'][:8]}_{fidx}"

                                        with Column(gap=2, css_class="rounded-md border border-slate-200 p-3 bg-slate-50"):
                                            with Row(gap=2, align="center", justify="between"):
                                                Text(finding, bold=True)
                                                Badge(f_status, variant="secondary")

                                            if f_status == "inactive":
                                                with Column(gap=1):
                                                    Label("Reason if dismissing")
                                                    Input(name=f"{f_prefix}_reason", value="")
                                                with Row(gap=2):
                                                    activate = CallTool(
                                                        "UpdateMaternalAction",
                                                        arguments={
                                                            "action": "activate-flag",
                                                            "flagId": flag_id,
                                                        },
                                                        on_success=[
                                                            ShowToast(
                                                                {
                                                                    "title": "Activated",
                                                                    "description": "Flag is now visible to the team.",
                                                                }
                                                            )
                                                        ],
                                                        on_error=ShowToast(
                                                            {
                                                                "title": "Activate failed",
                                                                "description": "See server logs.",
                                                                "variant": "destructive",
                                                            }
                                                        ),
                                                    )
                                                    dismiss = CallTool(
                                                        "UpdateMaternalAction",
                                                        arguments={
                                                            "action": "dismiss-flag",
                                                            "flagId": flag_id,
                                                            "reason": f"{{{{ {f_prefix}_reason }}}}",
                                                        },
                                                        on_success=[
                                                            ShowToast(
                                                                {
                                                                    "title": "Dismissed",
                                                                    "description": "Flag closed.",
                                                                }
                                                            )
                                                        ],
                                                        on_error=ShowToast(
                                                            {
                                                                "title": "Dismiss failed",
                                                                "description": "See server logs.",
                                                                "variant": "destructive",
                                                            }
                                                        ),
                                                    )
                                                    Button("Activate", variant="default", on_click=activate)
                                                    Button("Dismiss", variant="outline", on_click=dismiss)
                                            else:
                                                Muted(f"Status: {f_status} (no further actions)")

            # ── Footer disclaimer ─────────────────────────────────────────
            Separator()
            Muted(
                "Decision support only. Clinician review required before any action. "
                "MaternalGuard does not place orders, prescribe, or contact patients."
            )

    return app


if __name__ == "__main__":
    transport = os.getenv("TRANSPORT", "streamable-http")
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5001"))
    mcp.run(transport=transport, host=host, port=port)
