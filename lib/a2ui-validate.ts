// The single validation gate for AGENT-AUTHORED A2UI surfaces (the render_surface
// tool). The model emits a flat A2UI v0.9 component tree; this sanitizes it before
// it ever reaches React state or the live A2UI renderer. It is the surface-tree
// analogue of lib/deck/validate.ts and reuses the SAME coercion (normalizeProps)
// and the SAME Zod schemas (catalogDefinitions) for leaf overlays, so an authored
// surface can never render a Capturia component the agent path couldn't.
//
// Untrusted-input posture (agent JSON is never trusted):
//   - whitelist components to transparent layout primitives + the Capturia catalog
//     leaves (basic Card/Text/Button render off-brand Material chrome over the
//     webcam). The ONE interactive leaf is the branded ActionButton: its tap loop
//     runs client-side (the catalog renderer dispatches at click time, see
//     lib/a2ui-catalog.tsx), so the agent never authors event wiring.
//   - reject prototype-pollution keys and data-binding/action keys (there is no
//     data model; ActionButton's envelope is built at click time, never authored)
//   - reject cycles (the renderer follows child refs with no cycle guard → stack
//     overflow), dangling refs (→ shimmer placeholders), and oversized/over-deep trees
// Returns a cleaned flat node list (root first, only root-reachable nodes, leaf props
// normalized + schema-validated) or null on any violation.

import { catalogDefinitions, type CatalogKey } from "@/lib/catalog";
import { normalizeProps } from "@/lib/normalize";
import type { A2uiNode } from "@/lib/types";

// Transparent containers only. Basic Card/Text/Button and the rest of the
// Material basic catalog are intentionally excluded (see header); the one
// allowed interactive component, ActionButton, enters via CAPTURIA_TYPES
// below. Divider is allowed but cannot be the root.
const LAYOUT_PRIMITIVES = new Set(["Column", "Row", "List", "Divider"]);
const ROOT_LAYOUTS = new Set(["Column", "Row", "List"]);
const CAPTURIA_TYPES = new Set(Object.keys(catalogDefinitions));

// Own keys that must never appear anywhere in the tree.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Data-binding / action markers. The agent never authors bindings: there is no
// data model, and interactivity is confined to ActionButton, whose event
// envelope is built client-side at click time (lib/a2ui-catalog.tsx). Any of
// these keys in an authored tree means an unsupported feature; reject.
const BINDING_KEYS = new Set(["path", "call", "event"]);

// Style props kept per layout primitive; every other key on a layout node is dropped.
const LAYOUT_PROPS: Record<string, readonly string[]> = {
  Column: ["justify", "align"],
  Row: ["justify", "align"],
  List: ["direction", "align"],
  Divider: ["axis"],
};

const MAX_NODES = 40;
const MAX_DEPTH = 6;

// True if any plain-object own key anywhere in `value` is in `bad`. JSON.parse only
// produces own enumerable keys, so Object.keys is the correct (and safe) surface.
function scanKeys(value: unknown, bad: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((v) => scanKeys(v, bad));
  if (value && typeof value === "object") {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      if (bad.has(k)) return true;
      if (scanKeys((value as Record<string, unknown>)[k], bad)) return true;
    }
  }
  return false;
}

// Referenced child ids of a node (merging `child` + `children`), or null if the
// shape is invalid (non-string ids, or the object/data-bound `children` form).
function childIdsOf(node: A2uiNode): string[] | null {
  const ids: string[] = [];
  if (node.child !== undefined) {
    if (typeof node.child !== "string") return null;
    ids.push(node.child);
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) return null;
    for (const c of node.children) {
      if (typeof c !== "string") return null;
      ids.push(c);
    }
  }
  return ids;
}

// Strip a node down to a safe, predictable shape. Leaf overlays get the SAME
// normalize + Zod validation as the agent/deck paths; layout nodes keep only
// whitelisted style props plus their (already-validated) child references.
function cleanNode(node: A2uiNode, childIds: string[], isLayout: boolean): A2uiNode | null {
  if (!isLayout) {
    const { id: _id, component: _c, child: _ch, children: _chn, ...leafProps } = node;
    void _id; void _c; void _ch; void _chn;
    const normalized = normalizeProps(node.component, leafProps as Record<string, unknown>);
    const parsed = catalogDefinitions[node.component as CatalogKey].props.safeParse(normalized);
    if (!parsed.success) return null;
    return { id: node.id, component: node.component, ...parsed.data };
  }

  const clean: A2uiNode = { id: node.id, component: node.component };
  for (const key of LAYOUT_PROPS[node.component] ?? []) {
    const v = node[key];
    if (typeof v === "string") clean[key] = v;
  }
  if (childIds.length > 0) clean.children = childIds;
  return clean;
}

export function sanitizeSurfaceTree(parsed: unknown): A2uiNode[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_NODES) return null;

  // Pass 1: index by id with structural + safety checks.
  const byId = new Map<string, A2uiNode>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const node = raw as A2uiNode;
    if (typeof node.id !== "string" || typeof node.component !== "string") return null;
    if (byId.has(node.id)) return null; // duplicate id
    if (!LAYOUT_PRIMITIVES.has(node.component) && !CAPTURIA_TYPES.has(node.component)) return null;
    if (scanKeys(node, FORBIDDEN_KEYS)) return null; // prototype pollution
    if (scanKeys(node, BINDING_KEYS)) return null; // data binding / actions (unsupported)
    byId.set(node.id, node);
  }

  // Root must exist and be a layout container (never Card/Text/leaf).
  const root = byId.get("root");
  if (!root || !ROOT_LAYOUTS.has(root.component)) return null;

  // Pass 2: 3-color DFS from root — acyclic, depth-bounded, refs resolve, leaves
  // carry no children. cleaned doubles as the "fully validated" (black) set.
  const cleaned = new Map<string, A2uiNode>();
  const onPath = new Set<string>();

  const walk = (id: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (onPath.has(id)) return false; // back-edge → cycle
    if (cleaned.has(id)) return true; // shared child in a DAG: already validated
    const node = byId.get(id);
    if (!node) return false; // dangling reference

    const childIds = childIdsOf(node);
    if (childIds === null) return false;
    const isLayout = LAYOUT_PRIMITIVES.has(node.component);
    if (!isLayout && childIds.length > 0) return false; // leaves can't host children
    if (id === "root" && childIds.length === 0) return false; // empty surface

    const clean = cleanNode(node, childIds, isLayout);
    if (!clean) return false; // leaf failed schema validation

    onPath.add(id);
    for (const c of childIds) if (!walk(c, depth + 1)) return false;
    onPath.delete(id);
    cleaned.set(id, clean);
    return true;
  };

  if (!walk("root", 0)) return null;

  // Emit root first, then the remaining reachable nodes (orphans dropped).
  const rest: A2uiNode[] = [];
  for (const [id, node] of cleaned) if (id !== "root") rest.push(node);
  return [cleaned.get("root")!, ...rest];
}
