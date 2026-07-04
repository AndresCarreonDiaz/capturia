import { describe, it, expect } from "vitest";
import { sanitizeSurfaceTree } from "@/lib/a2ui-validate";
import type { A2uiNode } from "@/lib/types";

// The sanitizer is the single trust boundary for AGENT-AUTHORED surfaces: it
// takes whatever JSON the model produced and must return a clean flat node list
// or null, NEVER throw, and NEVER let an unsafe tree through. These tests pin
// every rejection path the DFS guards, plus the shapes that must survive.

// The canonical "stat block" from the system prompt (lib/system-prompt.ts), the
// reference valid tree. Built fresh per test so mutations never leak.
function validStatBlock(): unknown {
  return [
    { id: "root", component: "Column", align: "end", children: ["lt", "mp", "ring"] },
    { id: "lt", component: "LowerThird", name: "Acme", subtitle: "Q4 Review" },
    {
      id: "mp",
      component: "MetricsPanel",
      title: "Results",
      metrics: [
        { label: "Revenue", value: "$1.8M", delta: "+24%" },
        { label: "Users", value: "18K", delta: "+12%" },
      ],
    },
    { id: "ring", component: "StatRing", value: 92, label: "NPS" },
  ];
}

describe("sanitizeSurfaceTree: valid trees survive", () => {
  it("accepts the canonical stat block and emits root first", () => {
    const out = sanitizeSurfaceTree(validStatBlock());
    expect(out).not.toBeNull();
    const tree = out as A2uiNode[];
    expect(tree).toHaveLength(4);
    expect(tree[0].id).toBe("root");
    expect(tree[0].children).toEqual(["lt", "mp", "ring"]);
    // align is a whitelisted layout style prop and is kept.
    expect(tree[0].align).toBe("end");
    const ids = tree.map((n) => n.id).sort();
    expect(ids).toEqual(["lt", "mp", "ring", "root"]);
  });

  it("keeps only whitelisted layout style props (drops the rest)", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Row", justify: "center", bogus: "x", onClick: "y", children: ["a"] },
      { id: "a", component: "LiveBadge" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    const root = out[0];
    expect(root.justify).toBe("center");
    expect(root.bogus).toBeUndefined();
    expect(root.onClick).toBeUndefined();
  });

  it("runs leaf props through normalizeProps + schema (coerces numeric metric values)", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["mp"] },
      // value is a number here; normalizeProps must coerce it to a string so the
      // Zod schema (value: string) passes, proving the surface path reuses the
      // same coercion as add_overlay/deck.
      { id: "mp", component: "MetricsPanel", title: "Q", metrics: [{ label: "R", value: 1800000 }] },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    const mp = out.find((n) => n.id === "mp")!;
    const metrics = mp.metrics as Array<{ label: string; value: string }>;
    expect(metrics[0].value).toBe("1800000");
  });

  it("supports a DAG: a child shared by two parents is validated once and kept", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Row", children: ["a", "b"] },
      { id: "a", component: "Column", children: ["shared"] },
      { id: "b", component: "Column", children: ["shared"] },
      { id: "shared", component: "LiveBadge" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out.map((n) => n.id).sort()).toEqual(["a", "b", "root", "shared"]);
  });

  it("drops orphan (root-unreachable) nodes", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["a"] },
      { id: "a", component: "LowerThird", name: "x", subtitle: "y" },
      { id: "orphan", component: "StatRing", value: 5, label: "z" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out.map((n) => n.id)).toEqual(["root", "a"]);
  });
});

describe("sanitizeSurfaceTree: structural rejections return null", () => {
  it("rejects non-array, empty, and non-object entries", () => {
    expect(sanitizeSurfaceTree({})).toBeNull();
    expect(sanitizeSurfaceTree("nope")).toBeNull();
    expect(sanitizeSurfaceTree(null)).toBeNull();
    expect(sanitizeSurfaceTree([])).toBeNull();
    expect(sanitizeSurfaceTree([null])).toBeNull();
    expect(sanitizeSurfaceTree(["string-not-node"])).toBeNull();
  });

  it("rejects a tree larger than MAX_NODES (40)", () => {
    const big = Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, component: "Column" }));
    expect(sanitizeSurfaceTree(big)).toBeNull();
  });

  it("rejects nodes missing a string id or component", () => {
    expect(sanitizeSurfaceTree([{ component: "Column", children: [] }])).toBeNull();
    expect(sanitizeSurfaceTree([{ id: "root" }])).toBeNull();
    expect(sanitizeSurfaceTree([{ id: 1, component: "Column", children: [] }])).toBeNull();
  });

  it("rejects duplicate ids", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "LowerThird", name: "x", subtitle: "y" },
        { id: "a", component: "StatRing", value: 5, label: "z" },
      ])
    ).toBeNull();
  });

  it("rejects an unknown / non-whitelisted component type", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "Button", label: "Click" },
      ])
    ).toBeNull();
  });
});

describe("sanitizeSurfaceTree: root rules", () => {
  it("rejects a missing root", () => {
    expect(
      sanitizeSurfaceTree([{ id: "notroot", component: "Column", children: [] }])
    ).toBeNull();
  });

  it("rejects a leaf as root", () => {
    expect(
      sanitizeSurfaceTree([{ id: "root", component: "LowerThird", name: "x", subtitle: "y" }])
    ).toBeNull();
  });

  it("rejects Divider as root (layout primitive but not a root layout)", () => {
    expect(sanitizeSurfaceTree([{ id: "root", component: "Divider" }])).toBeNull();
  });

  it("rejects an empty root (no children)", () => {
    expect(sanitizeSurfaceTree([{ id: "root", component: "Column" }])).toBeNull();
    expect(sanitizeSurfaceTree([{ id: "root", component: "Column", children: [] }])).toBeNull();
  });
});

describe("sanitizeSurfaceTree: graph safety", () => {
  it("rejects a cycle (back-edge)", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "Column", children: ["root"] },
      ])
    ).toBeNull();
  });

  it("rejects a dangling child reference", () => {
    expect(
      sanitizeSurfaceTree([{ id: "root", component: "Column", children: ["ghost"] }])
    ).toBeNull();
  });

  it("rejects a tree deeper than MAX_DEPTH (6)", () => {
    // root(0) -> n1(1) -> ... -> n7(7); the walk hits depth 7 > 6 and bails.
    const nodes: unknown[] = [{ id: "root", component: "Column", children: ["n1"] }];
    for (let i = 1; i <= 6; i++) {
      nodes.push({ id: `n${i}`, component: "Column", children: [`n${i + 1}`] });
    }
    nodes.push({ id: "n7", component: "LiveBadge" });
    expect(sanitizeSurfaceTree(nodes)).toBeNull();
  });

  it("rejects a leaf that tries to host children", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "LowerThird", name: "x", subtitle: "y", children: ["b"] },
        { id: "b", component: "StatRing", value: 1, label: "z" },
      ])
    ).toBeNull();
  });

  it("rejects a non-string child id and the data-bound children object form", () => {
    expect(
      sanitizeSurfaceTree([{ id: "root", component: "Column", children: [123] }])
    ).toBeNull();
    expect(
      sanitizeSurfaceTree([{ id: "root", component: "Column", children: { path: "items" } }])
    ).toBeNull();
  });
});

describe("sanitizeSurfaceTree: injection / binding rejections", () => {
  it("rejects prototype-pollution keys anywhere in the tree", () => {
    // __proto__ as a real own key only arises via JSON.parse (a literal would hit
    // the prototype setter), so simulate the actual untrusted-input path.
    const withProto = JSON.parse(
      '[{"id":"root","component":"Column","children":["a"]},{"id":"a","component":"LiveBadge","__proto__":{"polluted":true}}]'
    );
    expect(sanitizeSurfaceTree(withProto)).toBeNull();

    for (const key of ["constructor", "prototype"]) {
      expect(
        sanitizeSurfaceTree([
          { id: "root", component: "Column", children: ["a"] },
          { id: "a", component: "LiveBadge", [key]: "x" },
        ])
      ).toBeNull();
    }
  });

  it("rejects data-binding / action keys (path, call, event)", () => {
    for (const key of ["path", "call", "event"]) {
      expect(
        sanitizeSurfaceTree([
          { id: "root", component: "Column", children: ["a"] },
          { id: "a", component: "LowerThird", name: "x", subtitle: "y", [key]: "anything" },
        ])
      ).toBeNull();
    }
  });

  it("rejects binding keys even when nested deep inside props", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "MetricsPanel", title: "Q", metrics: [{ label: "R", value: "1", event: "tap" }] },
      ])
    ).toBeNull();
  });
});

describe("sanitizeSurfaceTree: ActionButton (the one interactive leaf)", () => {
  it("accepts ActionButton leaves with label + actionName", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Row", justify: "center", children: ["yes", "no"] },
      { id: "yes", component: "ActionButton", label: "Yes", actionName: "poll-yes" },
      { id: "no", component: "ActionButton", label: "No", actionName: "poll-no", color: "#ef4444" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    const yes = out.find((n) => n.id === "yes")!;
    expect(yes.component).toBe("ActionButton");
    expect(yes.actionName).toBe("poll-yes");
  });

  it("rejects an ActionButton missing its required actionName", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Row", children: ["a"] },
        { id: "a", component: "ActionButton", label: "Tap me" },
      ])
    ).toBeNull();
  });

  it("rejects an ActionButton with an empty actionName (would render a dead button)", () => {
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Row", children: ["a"] },
        { id: "a", component: "ActionButton", label: "Tap me", actionName: "" },
      ])
    ).toBeNull();
  });

  it("interactivity did NOT weaken the sanitizer: an ActionButton that smuggles an event/path/call binding is still rejected", () => {
    for (const key of ["event", "path", "call"]) {
      expect(
        sanitizeSurfaceTree([
          { id: "root", component: "Row", children: ["a"] },
          { id: "a", component: "ActionButton", label: "Tap", actionName: "x", [key]: { name: "evil" } },
        ])
      ).toBeNull();
    }
  });
});

describe("sanitizeSurfaceTree: leaf schema validation", () => {
  it("rejects a leaf whose props fail its Zod schema", () => {
    // StatRing.value must be a number; a non-numeric string can't be coerced.
    expect(
      sanitizeSurfaceTree([
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "StatRing", value: "not-a-number", label: "z" },
      ])
    ).toBeNull();
  });

  it("strips unknown extra props from leaf nodes (Zod default-strip, pinned)", () => {
    // If a catalog schema is ever switched to .passthrough(), arbitrary agent
    // props would reach React; this test is the tripwire.
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["a"] },
      { id: "a", component: "LiveBadge", label: "ON AIR", style: { color: "red" }, dangerous: "x" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    const badge = out.find((n) => n.id === "a")!;
    expect(badge.label).toBe("ON AIR");
    expect(badge.style).toBeUndefined();
    expect(badge.dangerous).toBeUndefined();
  });

  it("never throws on arbitrary garbage: always A2uiNode[] | null", () => {
    const garbage: unknown[] = [
      undefined,
      42,
      [[[]]],
      { id: "root", component: "Column", children: ["a", "a", "a"] },
      { weird: Symbol.iterator },
    ];
    for (const g of garbage) {
      const r = sanitizeSurfaceTree(g);
      expect(r === null || Array.isArray(r)).toBe(true);
    }
  });
});

describe("sanitizeSurfaceTree: the singular `child` reference form", () => {
  it('accepts `child: "a"` and folds it into the cleaned children array', () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", child: "a" },
      { id: "a", component: "LiveBadge" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out[0].children).toEqual(["a"]);
  });

  it("keeps both refs when `child` and `children` are used together", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", child: "a", children: ["b"] },
      { id: "a", component: "LiveBadge" },
      { id: "b", component: "StatRing", value: 1, label: "z" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out[0].children).toEqual(["a", "b"]);
  });

  it("rejects non-string `child` values", () => {
    expect(sanitizeSurfaceTree([{ id: "root", component: "Column", child: 123 }])).toBeNull();
    expect(sanitizeSurfaceTree([{ id: "root", component: "Column", child: ["a"] }])).toBeNull();
  });
});

describe("sanitizeSurfaceTree: acceptance boundaries (functionality, not just safety)", () => {
  it("accepts a maximal tree of exactly MAX_NODES (40)", () => {
    const children = Array.from({ length: 39 }, (_, i) => `n${i}`);
    const nodes: unknown[] = [{ id: "root", component: "Column", children }];
    for (const id of children) nodes.push({ id, component: "LiveBadge" });
    const out = sanitizeSurfaceTree(nodes);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(40);
  });

  it("accepts a chain ending at exactly MAX_DEPTH (6)", () => {
    const nodes: unknown[] = [{ id: "root", component: "Column", children: ["n1"] }];
    for (let i = 1; i <= 5; i++) {
      nodes.push({
        id: `n${i}`,
        component: "Column",
        children: [i === 5 ? "leaf" : `n${i + 1}`],
      });
    }
    nodes.push({ id: "leaf", component: "LiveBadge" });
    expect(sanitizeSurfaceTree(nodes)).not.toBeNull();
  });

  it("drops non-string values on whitelisted layout props instead of keeping them", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Row", justify: 5, align: { x: 1 }, children: ["a"] },
      { id: "a", component: "LiveBadge" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out[0].justify).toBeUndefined();
    expect(out[0].align).toBeUndefined();
  });

  it("accepts List as root (direction kept, bogus props dropped)", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "List", direction: "horizontal", bogus: "x", children: ["a"] },
      { id: "a", component: "LiveBadge" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out[0].direction).toBe("horizontal");
    expect(out[0].bogus).toBeUndefined();
  });

  it("accepts a Divider inside the tree with its axis prop kept", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["a", "d", "b"] },
      { id: "a", component: "LiveBadge" },
      { id: "d", component: "Divider", axis: "horizontal" },
      { id: "b", component: "StatRing", value: 1, label: "z" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    const divider = out.find((n) => n.id === "d")!;
    expect(divider.axis).toBe("horizontal");
  });

  it("pins that Divider, being a layout primitive, may host children (validated as usual)", () => {
    // Odd but harmless: the leaf-with-children guard applies only to catalog
    // leaves. If this is ever tightened, this test documents the change.
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["d"] },
      { id: "d", component: "Divider", children: ["a"] },
      { id: "a", component: "LiveBadge" },
    ]);
    expect(out).not.toBeNull();
  });

  it("keeps duplicate sibling refs and emits the shared node once", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["a", "a"] },
      { id: "a", component: "LiveBadge" },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out[0].children).toEqual(["a", "a"]);
    expect(out.filter((n) => n.id === "a")).toHaveLength(1);
  });

  it("tolerates a cycle that lives only among orphan nodes (they are dropped)", () => {
    const out = sanitizeSurfaceTree([
      { id: "root", component: "Column", children: ["a"] },
      { id: "a", component: "LiveBadge" },
      { id: "x", component: "Column", children: ["y"] },
      { id: "y", component: "Column", children: ["x"] },
    ]) as A2uiNode[];
    expect(out).not.toBeNull();
    expect(out.map((n) => n.id)).toEqual(["root", "a"]);
  });
});
