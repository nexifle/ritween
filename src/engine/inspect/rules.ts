import { projectRect, type Affine2D } from "../../authoring/project-rect";
import type {
  InspectionBounds,
  InspectionDocument,
  InspectionLayoutNode,
} from "./report";

export const MAX_RULES_BYTES = 1024 * 1024;
export const MAX_RULES = 10_000;
export interface RuleTarget {
  readonly scope: string;
  readonly id?: string;
  readonly path?: string;
  readonly space: string;
  readonly bounds:
    "layout-slot" | "content" | "projected-paint" | "safe-rectangle";
  /** Content subtree by default; background selects exactly one own background record. */
  readonly paintSelection?: "content" | "background";
}
export interface InspectionRule {
  readonly id: string;
  readonly kind:
    | "containment"
    | "minimum-inset"
    | "minimum-gap"
    | "alignment"
    | "non-overlap";
  readonly a: RuleTarget;
  readonly b: RuleTarget;
  readonly space: string;
  /** Required when either operand selects projected paint. No implicit raster claim. */
  readonly assertionDomain?: "ideal-projected-bounds" | "pixel-contribution";
  readonly tolerance?: number;
  readonly minimum?: number;
  readonly edge?: "left" | "right" | "top" | "bottom";
  readonly axis?: "x" | "y";
  readonly align?: "start" | "center" | "end";
  readonly temporal?: {
    readonly start: number;
    readonly end: number;
    readonly includeEnd?: boolean;
    readonly samples: readonly number[];
  };
}
export interface RulesFile {
  readonly schemaVersion: 1;
  readonly rules: readonly InspectionRule[];
}
export class RulesInputError extends Error {}
function invalid(message: string): never {
  throw new RulesInputError(message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Expected a rules object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`Unknown rules field: ${key}`);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function target(value: unknown) {
  const t = object(value);
  keys(t, ["scope", "id", "path", "space", "bounds", "paintSelection"]);
  if (
    t.paintSelection !== undefined &&
    (t.bounds !== "projected-paint" ||
      !["content", "background"].includes(String(t.paintSelection)))
  )
    invalid(
      "paintSelection requires projected-paint and content or background.",
    );
  if (
    typeof t.scope !== "string" ||
    !/^(scene:.+|overlay)$/.test(t.scope) ||
    typeof t.space !== "string" ||
    !t.space.trim() ||
    /[\u0000-\u001f]/.test(t.space) ||
    /[\u0000-\u001f]/.test(t.scope)
  )
    invalid("Targets require a scope and coordinate space.");
  if ((t.id === undefined) === (t.path === undefined))
    invalid("Target needs exactly one ID or exact path.");
  const name = t.id ?? t.path;
  if (typeof name !== "string" || !name.trim() || /[\u0000-\u001f]/.test(name))
    invalid("Invalid target syntax.");
  if (
    !["layout-slot", "content", "projected-paint", "safe-rectangle"].includes(
      String(t.bounds),
    )
  )
    invalid("Invalid bounds kind.");
}
/** Parse before launching a browser. Limits apply to UTF-8, not JavaScript characters. */
export function parseRules(json: string): RulesFile {
  if (new TextEncoder().encode(json).length > MAX_RULES_BYTES)
    invalid("Rules exceed the 1 MiB limit.");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    invalid("Rules must be valid JSON.");
  }
  const file = object(raw);
  keys(file, ["schemaVersion", "rules"]);
  if (file.schemaVersion !== 1 || !Array.isArray(file.rules))
    invalid("Expected rules schemaVersion 1 and a rules array.");
  if (file.rules.length > MAX_RULES)
    invalid("Rules exceed the 10,000-rule limit.");
  const ids = new Set<string>();
  for (const entry of file.rules) {
    const r = object(entry);
    keys(r, [
      "id",
      "kind",
      "a",
      "b",
      "space",
      "tolerance",
      "assertionDomain",
      "minimum",
      "edge",
      "axis",
      "align",
      "temporal",
    ]);
    if (
      typeof r.id !== "string" ||
      !r.id.trim() ||
      /[\u0000-\u001f]/.test(r.id) ||
      ids.has(r.id)
    )
      invalid("Rule IDs must be unique non-empty strings.");
    ids.add(r.id);
    if (
      ![
        "containment",
        "minimum-inset",
        "minimum-gap",
        "alignment",
        "non-overlap",
      ].includes(String(r.kind))
    )
      invalid(`Unknown rule kind: ${r.kind}`);
    target(r.a);
    target(r.b);
    const hasPaint = [r.a, r.b].some(
      (t) => object(t).bounds === "projected-paint",
    );
    if (
      r.assertionDomain !== undefined &&
      !["ideal-projected-bounds", "pixel-contribution"].includes(
        String(r.assertionDomain),
      )
    )
      invalid("Invalid assertionDomain.");
    if (hasPaint && r.assertionDomain === undefined)
      invalid("Projected paint requires explicit assertionDomain.");
    if (
      typeof r.space !== "string" ||
      (r.space !== "output-pixels" && !/^(scene:.+|overlay)\/.+/.test(r.space))
    )
      invalid("Rule requires output-pixels or a qualified scope/space.");
    for (const key of ["minimum", "tolerance"])
      if (r[key] !== undefined && (!finite(r[key]) || r[key] < 0))
        invalid(`${key} must be finite and non-negative.`);
    if (
      ["minimum-inset", "minimum-gap"].includes(String(r.kind)) &&
      !finite(r.minimum)
    )
      invalid("Minimum rule requires a threshold.");
    if (
      r.edge !== undefined &&
      !["left", "right", "top", "bottom"].includes(String(r.edge))
    )
      invalid("Invalid edge.");
    if (r.axis !== undefined && !["x", "y"].includes(String(r.axis)))
      invalid("Invalid axis.");
    if (
      r.align !== undefined &&
      !["start", "center", "end"].includes(String(r.align))
    )
      invalid("Invalid alignment.");
    if (r.kind === "minimum-inset" && r.edge === undefined)
      invalid("Inset requires an edge.");
    if (
      ["minimum-gap", "alignment"].includes(String(r.kind)) &&
      r.axis === undefined
    )
      invalid("Rule requires an axis.");
    if (r.kind === "alignment" && r.align === undefined)
      invalid("Alignment requires start, center or end.");
    if (r.temporal !== undefined) {
      const t = object(r.temporal);
      keys(t, ["start", "end", "includeEnd", "samples"]);
      if (
        !finite(t.start) ||
        !finite(t.end) ||
        t.end <= t.start ||
        (t.includeEnd !== undefined && typeof t.includeEnd !== "boolean") ||
        !Array.isArray(t.samples)
      )
        invalid("Invalid temporal interval.");
      let previous = -Infinity;
      for (const sample of t.samples) {
        if (
          !finite(sample) ||
          sample <= previous ||
          sample < t.start ||
          sample > t.end ||
          (sample === t.end && !t.includeEnd)
        )
          invalid(
            "Samples must be finite, unique, sorted and inside the interval.",
          );
        previous = sample;
      }
    }
  }
  const parsed = JSON.parse(json) as RulesFile;
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(parsed);
  return parsed;
}
export interface RuleResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "indeterminate" | "not-applicable";
  readonly time: number;
  readonly space: string;
  readonly unit: "output-pixel" | "space-unit";
  readonly targets: readonly RuleTarget[];
  readonly accuracy: "exact-rectangle" | "conservative" | "unavailable";
  readonly measured?: readonly number[];
  readonly threshold?: number;
  readonly tolerance: number;
  readonly explanation: string;
  readonly assertionDomain:
    "layout-rectangles" | "ideal-projected-bounds" | "pixel-contribution";
  readonly provenance?: readonly string[];
  readonly capability?: "bounds-only" | "layout-geometry" | "unavailable";
}
interface Geometry {
  bounds: InspectionBounds;
  accuracy: "exact-rectangle" | "conservative";
  parts: readonly InspectionBounds[];
  /** An envelope is not a filled container. */
  container: boolean;
  provenance: readonly string[];
}
function resolve(
  doc: InspectionDocument,
  t: RuleTarget,
  space: string,
): Geometry {
  const scene = doc.scenes.find((s) => s.scope === t.scope);
  if (!scene?.tree)
    throw Error("missing-rule-target: scene unavailable or inactive");
  const matches: InspectionLayoutNode[] = [];
  const visit = (n: InspectionLayoutNode, inherited: string) => {
    const own = n.space ?? inherited;
    if (
      own === t.space &&
      (t.id !== undefined ? n.id === t.id : n.path === t.path)
    )
      matches.push(n);
    n.children.forEach((c) => visit(c, own));
  };
  visit(scene.tree, "layout");
  if (matches.length !== 1)
    throw Error(
      `${matches.length ? "ambiguous" : "missing"}-rule-target: ${t.id ?? t.path}`,
    );
  const n = matches[0];
  if (t.bounds !== "projected-paint") {
    const bounds =
      t.bounds === "content"
        ? n.contentBounds
        : t.bounds === "safe-rectangle"
          ? n.safeBounds
          : n.allocatedSlot;
    if (!bounds)
      throw Error(
        "unsupported-geometry-operation: requested bounds unavailable",
      );
    if (space === `${t.scope}/${t.space}`)
      return {
        bounds,
        accuracy: "exact-rectangle",
        parts: [bounds],
        container: true,
        provenance: [`${t.bounds}:layout-rectangle`],
      };
    if (space === "output-pixels") {
      const frames = scene.frameOccurrences?.filter((f) => f.layoutSpace.status === "known" && f.layoutSpace.id === t.space) ?? [];
      if (frames.length !== 1)
        throw Error("unsupported-geometry-operation: missing or ambiguous frame occurrence");
      const frame = frames[0];
      if (frame.parentSurface.status === "unavailable" && frame.parentSurface.reason !== "root render target is not a tagged surface.")
        throw Error("unsupported-geometry-operation: unrecorded parent surface");
      const ids = new Set<number>();
      const collect = (node: InspectionLayoutNode) => {
        if (node.inspectionId !== undefined) ids.add(node.inspectionId);
        node.children.forEach(collect);
      };
      collect(n);
      const cameras = frame.drawCameras.filter((c) => ids.has(c.ownerNodeId));
      const matrices = cameras.flatMap((c) => c.camera.status === "mapped" ? [c.camera.matrix] : []);
      if (!matrices.length || matrices.length !== cameras.length || matrices.some((m) => m.some((v, i) => v !== matrices[0][i])))
        throw Error("unsupported-geometry-operation: missing or ambiguous uploaded draw camera");
      if (!scene.outputLayoutMapping || scene.finalProjection.status !== "available")
        throw Error("unsupported-geometry-operation: final compositor mapping unavailable");
      const provenance = [`${t.bounds}:unclipped-layout-rectangle`, "uploaded-uniform:float32"];
      const apply = (matrix: Affine2D, input: InspectionBounds) => {
        // A degenerate rectangle is valid locally, but cannot establish output safety.
        const result = projectRect(input, matrix, 1);
        if (!result.visible) throw Error("unsupported-geometry-operation: singular or zero-area output mapping");
        return result;
      };
      const [sx, sy, tx, ty] = n.transform;
      let mapped = apply([sx, 0, 0, sy, tx, ty], bounds);
      let exact = mapped.accuracy === "exact";
      mapped = apply(matrices[0], mapped.bounds);
      exact &&= mapped.accuracy === "exact";
      if (frame.parentSurface.status === "known") {
        const parentId = frame.parentSurface.occurrenceId;
        const surfaces = scene.surfaceOccurrences?.filter((s) => s.occurrenceId === parentId) ?? [];
        if (surfaces.length !== 1 || surfaces[0].projection.status !== "mapped")
          throw Error("unsupported-geometry-operation: missing or ambiguous surface projection");
        // Deliberately do not intersect with the clip's outer rectangle: that would
        // manufacture an inner container and conceal content leaving its safe area.
        mapped = apply(surfaces[0].projection.childPixelsToScene, mapped.bounds);
        exact &&= mapped.accuracy === "exact";
        provenance.push("recorded-surface:childPixelsToScene:unclipped");
      }
      mapped = apply(scene.outputLayoutMapping.matrix, mapped.bounds);
      exact &&= mapped.accuracy === "exact";
      provenance.push("recorded-compositor:unclipped-placement:not-pixel-contribution");
      return { bounds: mapped.bounds, parts: [mapped.bounds], container: exact, accuracy: exact ? "exact-rectangle" : "conservative", provenance };
    }
    // Find a unique recorded route, including inverse World mappings. Never
    // infer transforms from rectangle ratios or from conservative envelopes.
    const destination = space.startsWith(`${t.scope}/`) ? space.slice(t.scope.length + 1) : undefined;
    if (!destination) throw Error("unsupported-geometry-operation: unrelated scene layout space");
    const descriptors = scene.spaces ?? [];
    if (new Set(descriptors.map((s) => s.id)).size !== descriptors.length)
      throw Error("unsupported-geometry-operation: ambiguous space mapping");
    const edges = new Map<string, { to: string; matrix: Affine2D }[]>();
    const edge = (from: string, to: string, matrix: Affine2D) => edges.set(from, [...(edges.get(from) ?? []), { to, matrix }]);
    for (const descriptor of descriptors) {
      if (descriptor.mapping.status !== "mapped" || descriptor.parent.status !== "known") continue;
      const m = descriptor.mapping.matrix;
      const [a, b, c, d, e, f] = m;
      const determinant = a * d - b * c;
      if (!Number.isFinite(determinant) || determinant === 0) continue;
      edge(descriptor.id, descriptor.parent.id, m);
      const inverse: Affine2D = [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
      if (inverse.every(Number.isFinite)) edge(descriptor.parent.id, descriptor.id, inverse);
    }
    const queue = [{ id: t.space, route: [] as Affine2D[] }];
    const visited = new Set<string>();
    let route: Affine2D[] | undefined;
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next.id)) continue;
      visited.add(next.id);
      if (next.id === destination) { route = next.route; break; }
      for (const item of edges.get(next.id) ?? []) queue.push({ id: item.to, route: [...next.route, item.matrix] });
    }
    if (!route) throw Error("unsupported-geometry-operation: missing or singular recorded space mapping");
    let projected = bounds;
    let exact = true;
    const provenance = [`${t.bounds}:layout-rectangle`];
    for (const matrix of route) {
      const result = projectRect(projected, matrix, 1);
      if (!result.visible && projected.width > 0 && projected.height > 0)
        throw Error("unsupported-geometry-operation: singular space mapping");
      projected = result.bounds;
      exact &&= result.accuracy === "exact";
      provenance.push("evaluateCamera:binary64-evaluated");
    }
    return {
      bounds: projected,
      parts: [projected],
      container: exact,
      accuracy: exact ? "exact-rectangle" : "conservative",
      provenance,
    };
  }
  if (space !== "output-pixels")
    throw Error("unsupported-geometry-operation: paint requires output-pixels");
  const nodeIds = new Set<number>();
  const gather = (node: InspectionLayoutNode) => {
    if (node.inspectionId !== undefined) nodeIds.add(node.inspectionId);
    node.children.forEach(gather);
  };
  gather(n);
  const records = scene.finalPaintRecords?.filter(
    (p) =>
      p.paintRole === (t.paintSelection ?? "content") &&
      p.inspection &&
      (t.paintSelection === "background"
        ? p.inspection.nodeId === n.inspectionId
        : nodeIds.has(p.inspection.nodeId)),
  );
  if (!records?.length || records.some((p) => p.accuracy === "unavailable"))
    throw Error(
      `unsupported-geometry-operation: ${scene.finalProjection?.status === "unavailable" ? scene.finalProjection.reason : "selected projected records unavailable or unrecorded"}`,
    );
  if (t.paintSelection === "background" && records.length !== 1)
    throw Error(
      "ambiguous-rule-target: background selection requires one own rectangle",
    );
  const rects = records.flatMap((p) =>
    p.accuracy !== "unavailable" && p.geometryVisible && p.sceneWeight > 0
      ? [p.bounds]
      : [],
  );
  if (!rects.length)
    throw Error("unsupported-geometry-operation: no positive-area paint");
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const bounds = {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
  return {
    bounds,
    parts: rects,
    accuracy: records.some((p) => p.accuracy === "conservative")
      ? "conservative"
      : "exact-rectangle",
    container:
      rects.length === 1 &&
      records.every((p) => p.accuracy === "exact-rectangle"),
    provenance: records.map((p) =>
      p.accuracy === "unavailable" ? p.unsupported : p.provenance,
    ),
  };
}
/** Pure evaluation. No renderer, mutation, serialization or all-pairs search. */
export function evaluateRules(
  doc: InspectionDocument,
  file: RulesFile,
): RuleResult[] {
  return file.rules.map((r) => {
    const time = doc.time.effective,
      tolerance = r.tolerance ?? 0.01;
    const base = {
      id: r.id,
      time,
      space: r.space,
      unit:
        r.space === "output-pixels"
          ? ("output-pixel" as const)
          : ("space-unit" as const),
      targets: [r.a, r.b],
      assertionDomain: r.assertionDomain ?? ("layout-rectangles" as const),
      tolerance,
    };
    const t = r.temporal;
    if (
      t &&
      (time < t.start || time > t.end || (time === t.end && !t.includeEnd))
    )
      return {
        ...base,
        status: "not-applicable",
        accuracy: "unavailable",
        explanation: "Outside the authored temporal interval.",
      };
    try {
      const hasPaint = [r.a, r.b].some((t) => t.bounds === "projected-paint");
      if (hasPaint && r.assertionDomain !== "ideal-projected-bounds")
        throw Error(
          "unsupported-geometry-operation: pixel contribution requires raster support not supplied by ideal quads (including zoom edge sampling); select ideal-projected-bounds explicitly for bounds-only measurement",
        );
      const a = resolve(doc, r.a, r.space),
        b = resolve(doc, r.b, r.space);
      const A = a.bounds,
        B = b.bounds;
      const conservative =
        a.accuracy === "conservative" || b.accuracy === "conservative";
      const insets = [
        A.x - B.x,
        B.x + B.width - A.x - A.width,
        A.y - B.y,
        B.y + B.height - A.y - A.height,
      ];
      let measured: number[],
        threshold =
          r.kind === "minimum-gap" || r.kind === "minimum-inset"
            ? r.minimum!
            : 0,
        pass: boolean;
      if (r.kind === "containment" || r.kind === "minimum-inset") {
        measured =
          r.kind === "containment"
            ? insets
            : [insets[["left", "right", "top", "bottom"].indexOf(r.edge!)]];
        pass = measured.every((v) => v + tolerance >= threshold);
        if (b.accuracy === "conservative" || !b.container)
          return {
            ...base,
            status: "indeterminate",
            accuracy: "conservative",
            measured,
            threshold,
            explanation:
              "A conservative container or aggregate envelope cannot prove containment or inset; holes are not filled.",
          };
      } else if (r.kind === "minimum-gap") {
        measured = [
          r.axis === "x" ? B.x - A.x - A.width : B.y - A.y - A.height,
        ];
        pass = measured[0] + tolerance >= threshold;
      } else if (r.kind === "alignment") {
        const factor = r.align === "start" ? 0 : r.align === "end" ? 1 : 0.5;
        measured = [
          r.axis === "x"
            ? A.x + A.width * factor - (B.x + B.width * factor)
            : A.y + A.height * factor - (B.y + B.height * factor),
        ];
        pass = Math.abs(measured[0]) <= tolerance;
      } else {
        measured = [
          Math.max(
            0,
            Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x),
          ),
          Math.max(
            0,
            Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y),
          ),
        ];
        // Test only this explicit pair's leaves; never treat an aggregate envelope as filled.
        pass = a.parts.every((a) =>
          b.parts.every(
            (b) =>
              Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <=
                tolerance ||
              Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <=
                tolerance,
          ),
        );
      }
      return {
        ...base,
        measured,
        threshold,
        provenance: [...a.provenance, ...b.provenance],
        capability: hasPaint ? "bounds-only" : "layout-geometry",
        status: pass
          ? "pass"
          : conservative && r.kind !== "alignment"
            ? "indeterminate"
            : "fail",
        accuracy: conservative ? "conservative" : "exact-rectangle",
        explanation:
          hasPaint || (r.kind === "alignment" && conservative)
            ? "Ideal projected bounds only (including conservative envelopes); no ink, raster coverage, occlusion or aesthetic claim."
            : conservative
              ? "Conservative outer bounds: possible violations are indeterminate, not proven pixel collisions."
              : "Exact layout rectangle comparison; not an aesthetic judgment.",
      };
    } catch (error) {
      const explanation = String(error);
      return {
        ...base,
        status: explanation.includes("rule-target") ? "fail" : "indeterminate",
        accuracy: "unavailable",
        capability: "unavailable",
        explanation,
      };
    }
  });
}
/** Coverage is independent of successful checks. Empty authored schedules cannot pass. */
export function summarizeRuleSchedule(
  file: RulesFile,
  results: readonly RuleResult[],
) {
  return file.rules.map((rule) => {
    const own = results.filter((r) => r.id === rule.id);
    const applicable = own.filter((r) => r.status !== "not-applicable");
    const missing =
      rule.temporal?.samples.filter(
        (time) => !applicable.some((r) => r.time === time),
      ) ?? [];
    return {
      id: rule.id,
      applicable: applicable.length,
      notApplicable: own.length - applicable.length,
      missing,
      coverageFailure:
        applicable.length === 0 ||
        missing.length > 0 ||
        (rule.temporal !== undefined && rule.temporal.samples.length === 0),
      failed: applicable.some(
        (r) => r.status === "fail" || r.status === "indeterminate",
      ),
    };
  });
}
