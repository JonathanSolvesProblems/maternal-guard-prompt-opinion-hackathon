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
  id?: string;
}

interface LayoutProps extends CommonProps {
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly";
}

export function column(props: LayoutProps = {}, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "Column", ...props, children });
}

export function row(props: LayoutProps = {}, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "Row", ...props, children });
}

export function grid(
  props: CommonProps & { minColumnWidth?: string; gap?: number } = {},
  children: PrefabNode[] = [],
): PrefabNode {
  return clean({ type: "Grid", ...props, children });
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
  label?: string;
  value?: string;
  variant?: BadgeVariant;
}
export function metric(props: MetricProps): PrefabNode {
  return clean({ type: "Metric", ...props });
}

interface InputProps extends CommonProps {
  name: string;
  value?: string;
  placeholder?: string;
  maxLength?: number;
  inputType?: "text" | "number" | "date";
}
export function input(props: InputProps): PrefabNode {
  // The HTML `type` attribute is exposed as `inputType` on our wrapper to avoid
  // colliding with the component discriminator field (`type: "Input"`).
  const { inputType, ...rest } = props;
  return clean({
    type: "Input",
    ...rest,
    ...(inputType ? { type_: inputType } : {}),
  });
}

export type ButtonVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "primary";

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
  unwrapResult?: boolean;
  onSuccess?: PrefabAction | PrefabAction[];
  onError?: PrefabAction | PrefabAction[];
}
export function callTool(opts: CallToolOpts): PrefabAction {
  return clean({
    action: "toolCall",
    tool: opts.tool,
    arguments: opts.arguments ?? {},
    unwrapResult: opts.unwrapResult,
    onSuccess: opts.onSuccess,
    onError: opts.onError,
  });
}

interface ShowToastOpts {
  title?: string;
  description?: string;
  variant?: "default" | "destructive" | "success" | "warning";
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
