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
export function cardTitle(text: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "CardTitle", ...props, children: [text] });
}
export function cardContent(props: CommonProps = {}, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "CardContent", ...props, children });
}

export function heading(text: string, level: 1 | 2 | 3 | 4 = 2, props: CommonProps = {}): PrefabNode {
  // prefab exposes H1..H4 components. We default to H2.
  const type = `H${level}` as `H${typeof level}`;
  return clean({ type, ...props, children: [text] });
}

export function text(content: string, opts: CommonProps & { bold?: boolean } = {}): PrefabNode {
  return clean({ type: "Text", ...opts, children: [content] });
}

export function muted(content: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "Muted", ...props, children: [content] });
}

export function label(content: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "Label", ...props, children: [content] });
}

export type BadgeVariant = "default" | "secondary" | "destructive" | "warning" | "success" | "outline";

export function badge(content: string, variant: BadgeVariant = "default", props: CommonProps = {}): PrefabNode {
  return clean({ type: "Badge", variant, ...props, children: [content] });
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
  return clean({ type: "Button", ...props, children: [content] });
}

interface AlertProps extends CommonProps {
  variant?: "default" | "warning" | "destructive" | "success";
}
export function alert(props: AlertProps, children: PrefabNode[] = []): PrefabNode {
  return clean({ type: "Alert", ...props, children });
}
export function alertTitle(content: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "AlertTitle", ...props, children: [content] });
}
export function alertDescription(content: string, props: CommonProps = {}): PrefabNode {
  return clean({ type: "AlertDescription", ...props, children: [content] });
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

  return clean({
    $prefab: "0.19",
    title: opts.title,
    view,
    state: opts.state ?? {},
    defs: opts.defs ?? {},
  });
}

// Wrap a PrefabApp payload into an MCP CallToolResult.
// We do not know exactly which content type Prompt Opinion picks up. Emit FOUR
// variants in parallel so at least one matches what the platform expects:
//   (1) embedded resource content with a prefab MIME type
//   (2) plain text content with the serialized JSON
//   (3) structuredContent at the top of the result
//   (4) a custom _meta block hinting at the renderer
// Once we observe which one renders, we can prune the others.
import { CallToolResult } from "@modelcontextprotocol/sdk/types";

export function prefabAppToCallToolResult(appPayload: Record<string, unknown>): CallToolResult {
  const serialized = JSON.stringify(appPayload);
  return {
    content: [
      {
        type: "resource" as const,
        resource: {
          uri: "prefab://app",
          mimeType: "application/vnd.prefab.app+json",
          text: serialized,
        },
      },
      {
        type: "text" as const,
        text: serialized,
      },
    ],
    structuredContent: appPayload,
    _meta: {
      "ai.promptopinion/renderer": "prefab",
      "ai.promptopinion/app-version": "0.19",
    },
    isError: false,
  };
}
