// Minimal TypeScript port of the PrefectHQ prefab-ui wire format.
//
// prefab-ui is a Python library that builds a JSON tree using context managers.
// The platform (Prompt Opinion) consumes the resulting JSON and renders it as
// interactive UI in chat. The Python library is unnecessary if we emit the
// same JSON shape directly.
//
// Wire format learned from reading the prefab-ui source on github:
//   - Each component serializes to { type: ClassName, ...props (camelCase) }
//   - Container components add `children`
//   - css_class -> cssClass, on_mount -> onMount (Pydantic serialization aliases)
//   - PrefabApp.to_json() returns { "$prefab": "...", view, defs, state }
//   - Actions: { action: "<actionType>" } (toolCall, showToast, setState)
//   - Template interpolation in CallTool arguments uses "{{ name }}" string syntax
//
// This module is intentionally minimal. Add component types as we need them.

export type PrefabNode = Record<string, unknown>;
export type PrefabAction = Record<string, unknown>;

// Strip undefined / null fields so the wire matches prefab's exclude_none=True.
function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// ─── Component builders ────────────────────────────────────────────────────
// Each function returns a node dict. Names match the Python class names so we
// match the `type` discriminator.

interface CommonProps {
  cssClass?: string;
  // NOTE: `id` is intentionally omitted here. The prefab-ui base schema
  // (`hi = Xn({cssClass, onMount})`) does not expose `id`, and Xn is
  // default-strip z.object so any `id` field is silently dropped by the
  // renderer. Keeping it out of the TypeScript type prevents callers from
  // assuming stable DOM ids they will never actually get.
}

// Column / Row / Grid schemas from the bundled renderer do NOT accept
// gap / align / justify props (Xn strips unknown keys). Layout tokens must
// be applied via cssClass utility strings. We keep the ergonomic tokens on
// the TS interface for readability, then translate them into Tailwind
// utility classes inside the builder — so tool code doesn't have to hand-
// write repetitive cssClass strings.
interface LayoutTokens {
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly";
}
interface LayoutProps extends CommonProps, LayoutTokens {}

function layoutCssClass(base: string | undefined, t: LayoutTokens): string | undefined {
  const parts: string[] = [];
  if (base) parts.push(base);
  if (typeof t.gap === "number") parts.push(`gap-${t.gap}`);
  if (t.align) parts.push(`items-${t.align}`);
  if (t.justify) parts.push(`justify-${t.justify}`);
  return parts.length ? parts.join(" ") : undefined;
}

export function column(props: LayoutProps = {}, children: PrefabNode[] = []): PrefabNode {
  const { cssClass, gap, align, justify } = props;
  return clean({
    type: "Column",
    cssClass: layoutCssClass(cssClass, { gap, align, justify }),
    children,
  });
}

export function row(props: LayoutProps = {}, children: PrefabNode[] = []): PrefabNode {
  const { cssClass, gap, align, justify } = props;
  return clean({
    type: "Row",
    cssClass: layoutCssClass(cssClass, { gap, align, justify }),
    children,
  });
}

export function grid(
  props: CommonProps & { minColumnWidth?: string; columnTemplate?: string; gap?: number } = {},
  children: PrefabNode[] = [],
): PrefabNode {
  // Grid schema only exposes `minColumnWidth` and `columnTemplate`; `gap`
  // is not a schema field. Push it into cssClass instead.
  const { cssClass, minColumnWidth, columnTemplate, gap } = props;
  const merged = layoutCssClass(cssClass, { gap });
  return clean({
    type: "Grid",
    cssClass: merged,
    minColumnWidth,
    columnTemplate,
    children,
  });
}

export function separator(props: CommonProps = {}): PrefabNode {
  return clean({ type: "Separator", ...props });
}

export function card(props: CommonProps = {}, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "Card", ...props, children });
}
export function cardHeader(props: CommonProps = {}, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "CardHeader", ...props, children });
}
// Text-carrying components: prefab-ui zod schema for each component defines
// EXACTLY which prop carries the visible string. Passing bare strings inside
// `children` blows up the renderer's tree walker with
//   Cannot use 'in' operator to search for '$ref' in <string>
// Extracted from static/prefab-renderer.html (v0.20.2 bundle):
//
//   Kf-based (require `content: string`):
//     H1, H2, H3, H4, P, Lead, Muted, Text, AlertTitle, AlertDescription,
//     CardTitle, CardDescription, Markdown
//   Label-based (require `label: string`):
//     Badge, Button
//   Special label prop:
//     Label uses `text`, not `label`
//     Metric uses `label` + `value`
export function cardTitle(text: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "CardTitle", ...props, content: text });
}
export function cardContent(props: CommonProps = {}, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "CardContent", ...props, children });
}

export function heading(text: string, level: 1 | 2 | 3 | 4 = 2, props: CommonProps = {}): PrefabNode {
  // prefab exposes H1..H4 components; each extends the Kf schema which
  // requires `content`, not children.
  const type = `H${level}` as `H${typeof level}`;
  return clean({ type, ...props, content: text });
}

export function text(content: string, opts: CommonProps & { bold?: boolean } = {}): PrefabNode {
  return clean({ type: "Text", ...opts, content });
}

export function muted(content: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "Muted", ...props, content });
}

export function label(content: string, props: CommonProps = {}): PrefabNode {
  // Label extends xi but its schema keys its display string under `text`,
  // not `content`. See renderer schema:
  //   xi.extend({type:Lt("Label"),text:tt().optional(),forId:tt().optional()})
  return clean({ type: "Label", ...props, text: content });
}

export type BadgeVariant = "default" | "secondary" | "destructive" | "warning" | "success" | "outline";

export function badge(content: string, variant: BadgeVariant = "default", props: CommonProps = {}): PrefabNode {
  return clean({ type: "Badge", variant, ...props, label: content });
}

interface MetricProps extends CommonProps {
  // Metric schema requires both label and value (see g3n=hi.extend({..,label:tt(),value:Ur([tt(),zn()])})).
  label: string;
  value: string | number;
  description?: string;
  delta?: string | number;
  trend?: "up" | "down" | "neutral";
  trendSentiment?: "positive" | "negative" | "neutral";
}
export function metric(props: MetricProps): PrefabNode {
  return clean({ type: "Metric", ...props });
}

interface InputProps extends CommonProps {
  name?: string;
  value?: string;
  placeholder?: string;
  maxLength?: number;
  // Field is literally `inputType` in the bundled schema (h3n=hi.extend({..,inputType:$r([...])})).
  // Previous builder renamed it to `type_`, which the schema silently
  // stripped, so number/date inputs quietly rendered as text.
  inputType?: "text" | "email" | "password" | "number" | "tel" | "url" | "search" | "date" | "time" | "datetime-local" | "file";
}
export function input(props: InputProps): PrefabNode {
  return clean({ type: "Input", ...props });
}

// Button schema variant enum (bundled renderer):
//   $r(["default","destructive","outline","secondary","ghost","link",
//       "success","warning","info"]).or(tt())
// NOTE: there is no "primary" — early builds emitted "primary" which fell
// through the .or(string) fallback and styled as default. Callers should
// use "default" for the visually-emphasised action.
export type ButtonVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "success" | "warning" | "info";

interface ButtonProps extends CommonProps {
  variant?: ButtonVariant;
  size?: "default" | "sm" | "lg";
  onClick?: PrefabAction | PrefabAction[];
}
export function button(content: string, props: ButtonProps = {}): PrefabNode {
  // Button extends hi and requires `label: string`; no children slot.
  return clean({ type: "Button", ...props, label: content });
}

interface AlertProps extends CommonProps {
  variant?: "default" | "warning" | "destructive" | "success";
}
export function alert(props: AlertProps, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "Alert", ...props, children });
}
export function alertTitle(content: string, props: CommonProps = {}): PrefabNode {
  // AlertTitle / AlertDescription both extend hi with a required `content`
  // prop; no children slot.
  return clean({ type: "AlertTitle", ...props, content });
}
export function alertDescription(content: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "AlertDescription", ...props, content });
}

// ─── Action builders ───────────────────────────────────────────────────────

interface CallToolOpts {
  tool: string;
  arguments?: Record<string, unknown>;
  onSuccess?: PrefabAction | PrefabAction[];
  onError?: PrefabAction | PrefabAction[];
}
export function callTool(opts: CallToolOpts): PrefabAction {
  // toolCall schema from the bundled renderer:
  //   YNe = Xn({ action:Lt("toolCall"), tool:tt(), arguments:record.optional(),
  //              onSuccess: union([Rg,array(Rg)]).optional(),
  //              onError:  union([Rg,array(Rg)]).optional() })
  // `unwrapResult` is not in the schema; it was silently stripped by Xn's
  // default z.object strip mode, so the earlier builder's `unwrapResult`
  // key never made it to the renderer runtime. Result unwrapping is now
  // caller responsibility on the server side.
  return clean({
    action: "toolCall",
    tool: opts.tool,
    arguments: opts.arguments ?? {},
    onSuccess: opts.onSuccess,
    onError: opts.onError,
  });
}

interface ShowToastOpts {
  // showToast schema from the bundled renderer:
  //   rRe = Xn({ action:Lt("showToast"), message:tt(), description:tt().optional(),
  //              variant:enum("default","success","error","warning","info").optional(),
  //              duration:zn().optional() })
  // The visible string is `message`, NOT `title`. Sending `title` produced
  //   [Prefab] Action validation error: Invalid "showToast" action Object
  // which silently disabled every button's onSuccess/onError toast.
  message: string;
  description?: string;
  variant?: "default" | "success" | "error" | "warning" | "info";
  duration?: number;
}
export function showToast(opts: ShowToastOpts): PrefabAction {
  return clean({
    action: "showToast",
    ...opts,
  });
}

// ─── PrefabApp + MCP wrapping ──────────────────────────────────────────────

interface PrefabAppOpts {
  title?: string;
  cssClass?: string;
  view: PrefabNode | PrefabNode[];
  state?: Record<string, unknown>;
  defs?: Record<string, PrefabNode>;
}

export function prefabApp(opts: PrefabAppOpts): Record<string, unknown> {
  const view = Array.isArray(opts.view)
    ? { type: "Column", children: opts.view }
    : opts.view;

  // Wire shape:
  //   { "$prefab": { "version": "0.3" }, "view": {...}, "state": {...} }
  //
  // The bundled prefab-ui renderer (v0.20.2 in static/prefab-renderer.html)
  // maintains a hard-coded protocol allowlist:
  //   const R3e = new Set(["0.3"]);
  //   if (g && !R3e.has(g)) console.warn(`[Prefab] Unrecognized protocol
  //     version "${g}" (supported: ${[...R3e].join(", ")})`);
  // The check only warns, but any drift will fire at runtime and any
  // future strict-mode bump on the renderer will silently blank the
  // iframe. Keep this in lockstep with static/prefab-renderer.html.
  //
  // We omit `title` and `defs` (never observed on a working LoopGuard
  // wire); the envelope keys are exactly [$prefab, view, state].
  return clean({
    $prefab: { version: "0.3" },
    view,
    state: opts.state ?? {},
  });
}

// Wrap a PrefabApp payload into an MCP CallToolResult.
//
// LoopGuard's live wire shows the tool result carries:
//   - content: [{ type: "text", text: "[Rendered Prefab UI]" }]  <-- stub placeholder
//   - structuredContent: <the $prefab envelope>                  <-- canonical channel
//   - isError: false
// The renderer reads structuredContent, not content. content is only a
// fallback for non-UI clients. We match that shape exactly. Placing the
// full JSON in content.text (as we did before) may make Prompt Opinion
// treat the tool as a text-returning tool and skip the UI mount.
import { CallToolResult } from "@modelcontextprotocol/sdk/types";

export function prefabAppToCallToolResult(appPayload: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: "[Rendered Prefab UI]",
      },
    ],
    structuredContent: appPayload,
    isError: false,
  };
}
