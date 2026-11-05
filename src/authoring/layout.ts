import { evaluatePath, pathData, type PathOutline } from "./path";
import { resolveNumber } from "./motion";
import { type ImageMask, clipOutline } from "./clip";
import { shapeGeometry } from "./shapes";
import type { MediaSpec } from "./media";
import { evaluateCamera, type CameraState } from "./camera";
import type { StageContext } from "./stage";
import type { PaintRecord } from "./renderer";
import {
  clipInspectionSurface,
  compositionInspectionSurface,
  groupInspectionSurface,
  type InspectionSurface,
} from "./surface-projection";
import type { Alignment, TextStyle, ViewNode } from "./nodes";

export interface Theme {
  readonly colors: Readonly<Record<string, string>>;
  readonly font: string;
  readonly textColor: string;
}
export const defaultTheme: Theme = Object.freeze({
  colors: Object.freeze({
    background: "#F4F0E7",
    ink: "#202B38",
    accent: "#4268EC",
  }),
  font: "Arial, sans-serif",
  textColor: "#202B38",
});
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TextRun {
  readonly lines: readonly string[];
  readonly widths: readonly number[];
  readonly font: string;
  readonly size: number;
  readonly lineHeight: number;
  readonly tracking: number;
  readonly color: string;
  readonly align: "left" | "center" | "right";
}
export type Transform = readonly [number, number, number, number]; // scale X/Y, translation X/Y
/**
 * Opt-in inspection association between one node and the commands it emitted. IDs come from a
 * single evaluation-local counter, so they are unique inside one root evaluation only — never
 * across frames or scopes.
 */
export interface InspectionIdentity {
  readonly id: number;
  readonly nodeId: number;
  readonly role: "content" | "background" | "surface";
}
export type DrawCommand = {
  readonly path: string;
  /** Opt-in inspection identity; absent unless `inspection` is enabled. */
  readonly inspection?: InspectionIdentity;
  readonly sharedId?: string;
  readonly bounds: Bounds;
  readonly transform: Transform;
  readonly opacity: number;
  /** `background` marks a modifier's own measured-bounds paint; content paints omit it. */
  readonly paintRole?: "background";
  /**
   * Semantic shared-element target declared on a modifier wrapper rather than on a draw
   * leaf. Only the wrapper's own paint carries it, so one declared ID yields exactly one
   * matching target while `sharedId` stays reserved for the child's own declared identity.
   */
  readonly matchId?: string;
  /**
   * Ordered paint-correction candidates for every paint of one declared modifier chain.
   * Distinct from `matchId`/`sharedId` (which decide *matching*): when a shared transition
   * corrects a declared ID, all paints of that chain must move together or a background and
   * its content drift apart. Ordered innermost declaration first, enclosing ancestors as
   * fallbacks, so an unmatched inner ID cannot suppress a matched outer one. The renderer
   * applies the first candidate that a transition actually supplies, never two matrices.
   */
  readonly correctionIds?: readonly string[];
} & (
  | {
      readonly kind: "composition";
      /** Set for a Clip or Composition while inspection is on. Composition has no shape. */
      readonly inspectionSurface?: InspectionSurface;
      readonly mask?: PathOutline;
      readonly imageMask?: ImageMask;
      readonly maskFillRule?: "nonzero" | "evenodd";
      readonly frame: EvaluatedFrame;
      readonly overlay?: EvaluatedFrame;
    }
  | {
      readonly kind: "group";
      /** Set only for an emitted Group, and only while inspection is on. */
      readonly inspectionSurface?: InspectionSurface;
      readonly frame: EvaluatedFrame;
      readonly overlay?: never;
    }
  | {
      readonly kind: "box";
      readonly fill: string;
      readonly radius: number;
      readonly stroke?: string;
      readonly strokeWidth: number;
    }
  | {
      readonly kind: "path";
      readonly data: string;
      readonly outline: PathOutline;
      readonly fill: string;
      readonly fillRule: "nonzero" | "evenodd";
    }
  | { readonly kind: "text"; readonly text: TextRun }
  | {
      readonly kind: "media";
      readonly source: MediaSpec;
      readonly time: number;
      readonly crop?: readonly [number, number, number];
    }
);
export interface LayoutSize {
  readonly width: number;
  readonly height: number;
}
export interface LayoutNode {
  readonly path: string;
  readonly kind: string;
  readonly bounds: Bounds;
  readonly transform: Transform;
  readonly children: readonly LayoutNode[];
  /** Author-declared ID from `ViewNode.id()`; absent for anonymous nodes and never synthetic. */
  readonly id?: string;
  /** Coordinate space these bounds were measured in. Absent means the frame's own
   * `layout` space; nested Composition worlds and overlays stamp their own scoped ID,
   * which descendants inherit because it is never overwritten. Clip descendants are
   * stamped `${clip space}/clip` because they are placed at the clip's local origin, so
   * `bounds` and `allocatedSlot` stay comparable inside that space. */
  readonly space?: string;
  /** Raw composition path prefix for legacy warning attribution. */
  readonly warningPrefix?: string;
  /**
   * Parent-offered dimensions at measurement time; opt-in inspection metadata.
   * Absent when inspection is disabled or for unbounded dimensions.
   */
  readonly offeredSize?: LayoutSize;
  /**
   * Layout slot allocated by the parent container; opt-in inspection metadata.
   * Absent when inspection is disabled.
   */
  readonly allocatedSlot?: Bounds;
  /**
   * Union of leaf content layout bounds, before any transform and in the same space as
   * `bounds`. Not paint bounds, not visibility, not ink. Opt-in inspection metadata;
   * absent when no leaf content aggregates in this space, including at Clip and
   * Composition boundaries, which keep their own scoped spaces.
   */
  readonly contentBounds?: Bounds;
  /**
   * Identity allocated by the one counter of this root evaluation. Opt-in inspection metadata;
   * absent when inspection is disabled. Rebasing a nested tree keeps it, because the node stays
   * the same node.
   */
  readonly inspectionId?: number;
}
/** Stable layout diagnostic codes (docs/plans/declarative-layout-hardening.md §7). */
export type LayoutDiagnosticCode =
  | "offered-size-overflow"
  | "fixed-allocation-deficit"
  | "unused-flex";
/**
 * Structured form of a layout conflict. `warnings` stays the legacy string list;
 * these entries are authored at the point of detection, never parsed back out of
 * the strings. `bounds` is the offered rectangle in the parent content box, which
 * is the geometry known at measurement time. Field-level contract for the public
 * JSON lives in `src/engine/inspect/report.ts`; this type is the emission side and
 * deliberately imports nothing from the engine.
 */
export interface LayoutDiagnostic {
  readonly code: LayoutDiagnosticCode;
  readonly severity: "warning" | "error";
  /** Author-declared node ID; unique only inside one scene/frame scope. */
  readonly id?: string;
  /** Exact node path inside its own coordinate space, as authored. */
  readonly path: string;
  /** Evaluation-local clock of the frame that detected this diagnostic. */
  readonly localTime: number;
  /** Coordinate space of `path`, `bounds`, `excess` and `deficit`: `layout` for the frame's own
   * box, the scoped ID of a nested Composition world or overlay, or `${clip space}/clip` for
   * content placed at a clip's local origin. Nested IDs are prefixed, so a deeper space already
   * conforms and is propagated rather than overwritten; `(space, path)` therefore identifies one
   * final node. */
  readonly space: string;
  readonly message: string;
  readonly bounds?: Bounds;
  readonly excess?: { readonly width: number; readonly height: number };
  readonly deficit?: number;
}
export interface EvaluatedFrame {
  /** Optional world → viewport camera; layout bounds remain in world space. */
  readonly camera?: CameraState;
  readonly tree: LayoutNode;
  readonly commands: readonly DrawCommand[];
  /** Legacy human-readable conflicts; preserved unchanged for existing callers. */
  readonly warnings: readonly string[];
  /** Present only when the frame reported at least one structured conflict. */
  readonly diagnostics?: readonly LayoutDiagnostic[];
  /** Internal: paint records collected by the renderer that drew this frame, inspection mode only. */
  readonly paintRecords?: readonly PaintRecord[];
}
export type MeasureText = (
  text: string,
  font: string,
  tracking: number,
) => number;
interface Measured {
  node: ViewNode;
  path: string;
  /** `path` with every segment space-encoded; the identity a clip appends `/clip` to. */
  spacePath: string;
  width: number;
  height: number;
  children: Measured[];
  text?: TextRun;
  composition?: EvaluatedFrame;
  overlay?: EvaluatedFrame;
  shape?: ReturnType<typeof shapeGeometry>;
  offeredSize?: LayoutSize;
  allocatedSlotMain?: number;
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw Error(`${name} must be finite and non-negative.`);
  return value;
}
/** Encode a segment in coordinate space identity so authored IDs with slashes cannot collide with space separators. */
export function encodeSpaceSegment(segment: string): string {
  return segment.replaceAll("%", "%25").replaceAll("/", "%2F");
}
/** Rebase a space ID onto the composition path that owns it. A deeper space already carries its
 * own scoped prefix, so it is extended instead of replaced; `layout` means "this frame's own". */
function rebaseSpaceId(space: string, prefix: string): string {
  return space === "layout" ? prefix : `${prefix}/${space}`;
}
/** Rebase an existing warning prefix exactly once with the outer composition path. */
function rebaseWarningPrefix(
  oldPrefix: string | undefined,
  outerPrefix: string,
): string {
  return oldPrefix ? `${outerPrefix}/${oldPrefix}` : outerPrefix;
}
/** Fill the clip-local space in on descendants that carry none. An explicit space from a nested
 * composition or a deeper clip is kept, so nested scopes stay unique and inheritable. */
function fillClipSpace(node: LayoutNode, space: string): LayoutNode {
  if (node.space !== undefined) return node;
  return {
    ...node,
    space,
    children: node.children.map((child) => fillClipSpace(child, space)),
  };
}
/** Shared empty stamp: with inspection off neither a command nor a node allocates an identity
 * object, so both spreads reuse this frozen value and keep the fields absent. */
const noIdentity = Object.freeze({}) as {
  readonly inspection?: InspectionIdentity;
  readonly inspectionId?: number;
};
/** One command's identity, drawn from the root evaluation's counter. Owner first, then ID, so
 * the owner is the node that emits the command rather than one guessed from a path. */
function commandIdentity(
  counter: { next: number } | undefined,
  nodeId: number | undefined,
  role: InspectionIdentity["role"],
): { readonly inspection?: InspectionIdentity } {
  return counter === undefined || nodeId === undefined
    ? noIdentity
    : { inspection: { id: counter.next++, nodeId, role } };
}
/**
 * Union of the children's `contentBounds`, which are already placed in this node's own
 * coordinate space. Children without content are skipped, and a zero-area leaf rectangle
 * is preserved rather than treated as absent.
 */
function contentUnion(children: readonly LayoutNode[]): Bounds | undefined {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  let found = false;
  for (const child of children) {
    const b = child.contentBounds;
    if (!b) continue;
    found = true;
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return found
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
}
/** Stamp nested trees with their scoped space so descendants inherit it rather than guess. */
function rebaseSpace(
  node: LayoutNode,
  space: string,
  warningPrefix?: string,
): LayoutNode {
  return {
    ...node,
    space: rebaseSpaceId(node.space ?? "layout", space),
    ...(warningPrefix
      ? {
          warningPrefix: rebaseWarningPrefix(node.warningPrefix, warningPrefix),
        }
      : node.warningPrefix
        ? { warningPrefix: node.warningPrefix }
        : {}),
    children: node.children.map((child) =>
      rebaseSpace(child, space, warningPrefix),
    ),
  };
}
/**
 * Declared IDs along one single-child modifier chain, outermost first. A background wrapper
 * paints the bounds of the content it decorates, so when the ID was declared on the inner
 * leaf (`.id("card").background(...)`) the wrapper paint must ride that same pose or the
 * decoration would stay behind while the content animates. Walking inward also collects the
 * inner declarations, so every paint of the chain can share one identical candidate list.
 */
function declaredChainIds(m: Measured): string[] {
  const ids: string[] = [];
  for (let node: Measured | undefined = m; node;) {
    const current: Measured = node;
    if (current.node.key) ids.push(current.node.key);
    node = "child" in current.node.spec ? current.children[0] : undefined;
  }
  return ids;
}
/** Innermost-first candidate list: this declaration, then nearer ancestors, then enclosing ones. */
function correctionCandidates(
  m: Measured,
  inherited: readonly string[],
): readonly string[] {
  const ids = declaredChainIds(m).reverse();
  for (const id of inherited) if (!ids.includes(id)) ids.push(id);
  return ids;
}
function align(value: Alignment, remaining: number): number {
  switch (value) {
    case "start":
      return 0;
    case "center":
      return remaining / 2;
    case "end":
      return remaining;
    default:
      throw Error(`Unknown alignment: ${value}`);
  }
}
function textLayout(
  value: string,
  style: TextStyle,
  width: number,
  theme: Theme,
  measure: MeasureText,
): TextRun {
  const size = positive(style.size ?? 40, "Text size");
  if (size === 0) throw Error("Text size must be positive.");
  const lineHeight = positive(style.lineHeight ?? size * 1.25, "Line height");
  if (lineHeight === 0) throw Error("Line height must be positive.");
  const weight = style.weight ?? 600;
  if (!Number.isFinite(weight) || weight < 1 || weight > 1000)
    throw Error("Font weight must be between 1 and 1000.");
  const tracking = style.tracking ?? 0;
  if (!Number.isFinite(tracking)) throw Error("Tracking must be finite.");
  const font = `${style.weight ?? 600} ${size}px ${style.font ?? theme.font}`;
  const limit = Math.min(
    width,
    positive(style.maxWidth ?? width, "Text maxWidth"),
  );
  const textWidth = (s: string) =>
    positive(measure(s, font, tracking), "Measured text width");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (style.wrap === false || paragraph === "") {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/u)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate) <= limit) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const { segment } of segmenter.segment(word)) {
        if (line && textWidth(line + segment) > limit) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line);
  }
  return {
    lines,
    widths: lines.map(textWidth),
    font,
    size,
    lineHeight,
    tracking,
    color: style.color ?? theme.textColor,
    align: style.align ?? "left",
  };
}

interface BoundaryChain {
  readonly flexWeights: readonly number[];
  readonly hasNumericMainFrame: boolean;
}

function inspectBoundaryChain(
  child: ViewNode,
  horizontal: boolean,
): BoundaryChain {
  const flexWeights: number[] = [];
  let hasNumericMainFrame = false;

  let current: ViewNode = child;
  while (true) {
    const s = current.spec;
    if (s.kind === "flex") {
      flexWeights.push(s.weight);
      current = s.child;
    } else if (s.kind === "frame") {
      const mainDim = horizontal ? s.width : s.height;
      if (mainDim !== undefined && mainDim !== "fill") {
        hasNumericMainFrame = true;
      }
      current = s.child;
    } else if (
      s.kind === "padding" ||
      s.kind === "offset" ||
      s.kind === "opacity" ||
      s.kind === "scale" ||
      s.kind === "background" ||
      s.kind === "clip"
    ) {
      current = s.child;
    } else {
      break;
    }
  }

  return {
    flexWeights,
    hasNumericMainFrame,
  };
}

function isLegacyFlexible(node: ViewNode, horizontal: boolean): boolean {
  const spec = node.spec;
  if (spec.kind === "spacer") return true;
  if (spec.kind === "frame") {
    const dimension = horizontal ? spec.width : spec.height;
    if (dimension !== undefined) return dimension === "fill";
  }
  return "child" in spec && isLegacyFlexible(spec.child, horizontal);
}

function isSpacerLeaf(node: ViewNode): boolean {
  let curr: ViewNode = node;
  while ("child" in curr.spec) {
    curr = curr.spec.child;
  }
  return curr.spec.kind === "spacer";
}

function capBoundaryWrappers(
  m: Measured,
  slotMain: number,
  horizontal: boolean,
): void {
  let levelBudget = slotMain;
  for (let curr: Measured | undefined = m; curr; ) {
    const s = curr.node.spec;
    if (
      s.kind === "offset" ||
      s.kind === "opacity" ||
      s.kind === "scale" ||
      s.kind === "background" ||
      s.kind === "clip" ||
      s.kind === "frame" ||
      s.kind === "padding" ||
      s.kind === "flex"
    ) {
      if (horizontal) {
        curr.width = Math.min(curr.width, levelBudget);
      } else {
        curr.height = Math.min(curr.height, levelBudget);
      }
      if (s.kind === "padding") {
        const insets = horizontal ? s.left + s.right : s.top + s.bottom;
        levelBudget = Math.max(0, levelBudget - insets);
      }
      curr = curr.children[0];
    } else {
      break;
    }
  }
}

/** CPU-only layout. The injected measurer must use the same fonts as rendering. */
export function evaluateView(
  root: ViewNode,
  options: {
    time: number;
    width: number;
    height: number;
    theme?: Theme;
    measureText: MeasureText;
    context?: StageContext;
    /** Internal recursion guard for nested compositions. */
    depth?: number;
    /** Opt-in: compute and record layout inspection metadata (offeredSize, allocatedSlot). */
    inspection?: boolean;
  },
): EvaluatedFrame {
  return evaluateViewWithCounter(root, options, undefined);
}
/** Implementation of {@link evaluateView} with the enclosing root's ID counter. Only a nested
 * composition passes one, so node and command IDs stay unique under that root; a public call
 * always starts its own, keeping identity per root instead of caller-injectable. */
function evaluateViewWithCounter(
  root: ViewNode,
  options: Parameters<typeof evaluateView>[1],
  rootCounter: { next: number } | undefined,
): EvaluatedFrame {
  const { time, measureText } = options;
  // One counter per root evaluation. Without inspection it stays undefined and nothing is
  // allocated, numbered, or added to the tree and commands.
  const counter = options.inspection ? (rootCounter ?? { next: 0 }) : undefined;
  const depth = options.depth ?? 0;
  if (depth > 32) throw Error("Composition nesting exceeds 32 levels.");
  if (!Number.isFinite(time)) throw Error("Time must be finite.");
  const width = positive(options.width, "Stage width"),
    height = positive(options.height, "Stage height");
  const theme = options.theme ?? defaultTheme;
  const warnings: string[] = [];
  const diagnostics: LayoutDiagnostic[] = [];
  const commands: DrawCommand[] = [];
  // `diagnosticSpace` mirrors the space placement stamps on the same node, so a diagnostic keeps
  // the `(space, path)` identity of the node it describes instead of always claiming `layout`.
  function measure(
    node: ViewNode,
    w: number,
    h: number,
    path: string,
    axis?: boolean,
    spacePath = encodeSpaceSegment(path),
    diagnosticSpace = "layout",
  ): Measured {
    try {
      const s = node.spec;
      const m: Measured = {
        node,
        path,
        spacePath,
        width: 0,
        height: 0,
        children: [],
      };
      if (
        options.inspection &&
        Number.isFinite(w) &&
        Number.isFinite(h) &&
        w >= 0 &&
        h >= 0
      ) {
        m.offeredSize = { width: w, height: h };
      }
      if (s.kind === "composition") {
        const settings = s.options;
        const viewport = settings.size ?? s.world.size;
        const env: StageContext = {
          time,
          localTime: time,
          progress: 0,
          resolution: [width, height],
          ...options.context,
          theme: settings.theme ?? theme,
          designSize: viewport,
        };
        const worldTime = time * (settings.rate ?? 1) + (settings.offset ?? 0);
        const worldEnv = {
          ...env,
          localTime: worldTime,
          designSize: s.world.size,
        };
        const frame = evaluateViewWithCounter(
          s.world.view(worldEnv),
          {
            time: worldTime,
            width: s.world.size[0],
            height: s.world.size[1],
            theme: env.theme,
            measureText,
            context: worldEnv,
            depth: depth + 1,
            inspection: options.inspection,
          },
          counter,
        );
        // Nested geometry is measured in the world's/overlay's own space. Both the tree and the
        // diagnostics are stamped with that space and keep paths relative to it, so `(space, path)`
        // identifies the same node in both. Legacy warning strings keep their historical prefix.
        m.composition = {
          ...frame,
          tree: rebaseSpace(frame.tree, `${spacePath}/world`, `${path}/world`),
          camera: evaluateCamera(
            typeof settings.camera === "function"
              ? settings.camera(env)
              : (settings.camera ?? {}),
            time,
            viewport,
          ),
        };
        if (settings.overlay) {
          const nested = evaluateViewWithCounter(
            settings.overlay(env),
            {
              time,
              width: viewport[0],
              height: viewport[1],
              theme: env.theme,
              measureText,
              context: env,
              depth: depth + 1,
              inspection: options.inspection,
            },
            counter,
          );
          m.overlay = {
            ...nested,
            tree: rebaseSpace(
              nested.tree,
              `${spacePath}/overlay`,
              `${path}/overlay`,
            ),
          };
        }
        m.width = viewport[0];
        m.height = viewport[1];
        warnings.push(
          ...frame.warnings.map((w) => `${path}/world/${w}`),
          ...(m.overlay?.warnings.map((w) => `${path}/overlay/${w}`) ?? []),
        );
        for (const inner of frame.diagnostics ?? [])
          diagnostics.push({
            ...inner,
            space: rebaseSpaceId(inner.space, `${spacePath}/world`),
          });
        for (const inner of m.overlay?.diagnostics ?? [])
          diagnostics.push({
            ...inner,
            space: rebaseSpaceId(inner.space, `${spacePath}/overlay`),
          });
      } else if (s.kind === "circle" || s.kind === "line") {
        const geometry = shapeGeometry(s, time);
        m.shape = geometry;
        m.width = geometry.width;
        m.height = geometry.height;
      } else if (s.kind === "image" || s.kind === "video") {
        if (s.style.crop) {
          const x = resolveNumber(s.style.crop.x ?? 0.5, time),
            y = resolveNumber(s.style.crop.y ?? 0.5, time),
            zoom = resolveNumber(s.style.crop.zoom ?? 1, time);
          if (x < 0 || x > 1 || y < 0 || y > 1 || zoom < 1)
            throw Error(
              "Crop requires focal x/y between 0 and 1 and zoom >= 1.",
            );
        }
        m.width = s.style.width;
        m.height = s.style.height;
      } else if (s.kind === "path") {
        m.width = s.style.width;
        m.height = s.style.height;
      } else if (s.kind === "text") {
        m.text = textLayout(s.text, s.style, w, theme, measureText);
        m.width = Math.max(0, ...m.text.widths);
        m.height = m.text.lines.length * m.text.lineHeight;
      } else if (s.kind === "box") {
        m.width = positive(resolveNumber(s.style.width, time), "Box width");
        m.height = positive(resolveNumber(s.style.height, time), "Box height");
        positive(s.style.radius ?? 0, "Radius");
        positive(s.style.strokeWidth ?? 0, "Stroke width");
      } else if (s.kind === "spacer") {
        m.width = axis === true ? w : 0;
        m.height = axis === false ? h : 0;
      } else if ("child" in s) {
        let cw = w,
          ch = h;
        if (s.kind === "padding") {
          for (const value of [s.top, s.right, s.bottom, s.left])
            positive(value, "Padding");
          cw = Math.max(0, w - s.left - s.right);
          ch = Math.max(0, h - s.top - s.bottom);
        } else if (s.kind === "frame") {
          cw =
            s.width === undefined || s.width === "fill"
              ? w
              : positive(s.width, "Frame width");
          ch =
            s.height === undefined || s.height === "fill"
              ? h
              : positive(s.height, "Frame height");
        } else if (s.kind === "flex") {
          if (axis === undefined) {
            warnings.push(
              `${path}: flex has no effect outside HStack or VStack at localTime=${time}`,
            );
            diagnostics.push({
              code: "unused-flex",
              severity: "warning",
              ...(m.node.key ? { id: m.node.key } : {}),
              path,
              localTime: time,
              space: diagnosticSpace,
              message: `flex has no effect outside HStack or VStack at localTime=${time}.`,
              bounds: { x: 0, y: 0, width: w, height: h },
            });
          }
        }
        const childKey = s.child.key ?? s.child.spec.kind;
        // Clip content is placed at the clip's local origin, so it joins `${spacePath}/clip`.
        const child = measure(
          s.child,
          cw,
          ch,
          `${path}/${childKey}`,
          axis,
          `${spacePath}/${encodeSpaceSegment(childKey)}`,
          s.kind === "clip" ? `${spacePath}/clip` : diagnosticSpace,
        );
        m.children = [child];
        m.width = child.width;
        m.height = child.height;
        if (s.kind === "padding") {
          m.width += s.left + s.right;
          m.height += s.top + s.bottom;
        }
        if (s.kind === "frame") {
          if (s.width !== undefined) m.width = cw;
          if (s.height !== undefined) m.height = ch;
        }
        if (s.kind === "flex" && axis !== undefined) {
          if (axis) {
            m.width = w;
            m.height = child.height;
          } else {
            m.width = child.width;
            m.height = h;
          }
        }
      } else {
        const gap = positive(s.options.gap ?? 0, "Stack gap");
        const horizontal = s.kind === "hstack",
          overlay = s.kind === "zstack" || s.kind === "group";
        const main = horizontal ? w : h;
        const totalGaps = overlay ? 0 : gap * Math.max(0, s.children.length - 1);
        const available = Math.max(0, main - totalGaps);
        let remaining = available;
        // Sum of rigid main-axis sizes, kept only to report a deficit; allocation stays clamped.
        let rigid = 0;
        const keys = new Set<string>();
        const chains = s.children.map((child, i) => {
          const key = child.key ?? `${child.spec.kind}[${i}]`;
          if (keys.has(key)) throw Error(`Duplicate sibling ID: ${key}`);
          keys.add(key);
          if (overlay) return undefined;
          const childPath = `${path}/${key}`;
          const chain = inspectBoundaryChain(child, horizontal);
          if (chain.flexWeights.length > 1) {
            throw Error(
              `${childPath}: Multiple flex modifiers on the same boundary chain are not supported.`,
            );
          }
          if (chain.flexWeights.length === 1 && chain.hasNumericMainFrame) {
            throw Error(
              `${childPath}: Flex cannot be combined with a fixed main-axis frame.`,
            );
          }
          return chain;
        });
        const hasExplicitFlex =
          !overlay && chains.some((c) => c && c.flexWeights.length > 0);
        if (!hasExplicitFlex) {
          const flexible = (node: ViewNode): boolean =>
            isLegacyFlexible(node, horizontal);
          const results: (Measured | undefined)[] = s.children.map(
            (child, i) => {
              const key = child.key ?? `${child.spec.kind}[${i}]`;
              if (!overlay && flexible(child)) return undefined;
              const measured = measure(
                child,
                horizontal && !overlay ? available : w,
                !horizontal && !overlay ? available : h,
                `${path}/${key}`,
                overlay ? undefined : horizontal,
                `${spacePath}/${encodeSpaceSegment(key)}`,
                diagnosticSpace,
              );
              if (!overlay) {
                const extent = horizontal ? measured.width : measured.height;
                remaining = Math.max(0, remaining - extent);
                rigid += extent;
              }
              return measured;
            },
          );
          const flexibleCount = results.filter((r) => !r).length;
          const requiredMain = rigid + totalGaps;
          if (flexibleCount && requiredMain > main + 0.01)
            diagnostics.push({
              code: "fixed-allocation-deficit",
              severity: "error",
              ...(m.node.key ? { id: m.node.key } : {}),
              path,
              localTime: time,
              space: diagnosticSpace,
              message: `Fixed ${horizontal ? "columns" : "rows"} exceed the offered main-axis slot at localTime=${time}; ${flexibleCount} flexible child(s) receive no space.`,
              bounds: { x: 0, y: 0, width: w, height: h },
              deficit: requiredMain - main,
            });
          m.children = results.map((result, i) => {
            if (result) return result;
            const child = s.children[i],
              spacer = child.spec.kind === "spacer";
            const childKey = child.key ?? `${child.spec.kind}[${i}]`;
            const flexibleSlot = remaining / flexibleCount;
            const measuredChild = measure(
              child,
              horizontal ? flexibleSlot : spacer ? 0 : w,
              horizontal ? (spacer ? 0 : h) : flexibleSlot,
              `${path}/${childKey}`,
              horizontal,
              `${spacePath}/${encodeSpaceSegment(childKey)}`,
              diagnosticSpace,
            );
            if (options.inspection) {
              measuredChild.allocatedSlotMain = flexibleSlot;
            }
            return measuredChild;
          });
        } else {
          const weights: (number | undefined)[] = chains.map((chain, i) => {
            if (!chain) return undefined;
            if (chain.flexWeights.length === 1) return chain.flexWeights[0];
            if (isLegacyFlexible(s.children[i], horizontal)) return 1;
            return undefined;
          });
          const results: (Measured | undefined)[] = s.children.map(
            (child, i) => {
              if (weights[i] !== undefined) return undefined;
              const key = child.key ?? `${child.spec.kind}[${i}]`;
              const measured = measure(
                child,
                horizontal ? available : w,
                !horizontal ? available : h,
                `${path}/${key}`,
                horizontal,
                `${spacePath}/${encodeSpaceSegment(key)}`,
                diagnosticSpace,
              );
              const extent = horizontal ? measured.width : measured.height;
              remaining = Math.max(0, remaining - extent);
              rigid += extent;
              return measured;
            },
          );
          const flexibleCount = results.filter((r) => !r).length;
          const requiredMain = rigid + totalGaps;
          if (flexibleCount && requiredMain > main + 0.01) {
            diagnostics.push({
              code: "fixed-allocation-deficit",
              severity: "error",
              ...(m.node.key ? { id: m.node.key } : {}),
              path,
              localTime: time,
              space: diagnosticSpace,
              message: `Fixed ${horizontal ? "columns" : "rows"} exceed the offered main-axis slot at localTime=${time}; ${flexibleCount} flexible child(s) receive no space.`,
              bounds: { x: 0, y: 0, width: w, height: h },
              deficit: requiredMain - main,
            });
          }
          const activeWeights = weights.filter(
            (w): w is number => w !== undefined,
          );
          const maxWeight = activeWeights.length
            ? Math.max(...activeWeights)
            : 0;
          const normalizedWeights = weights.map((w) =>
            w !== undefined && maxWeight > 0 ? w / maxWeight : undefined,
          );
          const totalNormalizedWeight = normalizedWeights.reduce(
            (sum: number, w) => sum + (w ?? 0),
            0,
          );
          m.children = results.map((result, i) => {
            if (result) return result;
            const child = s.children[i];
            const childKey = child.key ?? `${child.spec.kind}[${i}]`;
            const spacer = isSpacerLeaf(child);
            const proportion =
              flexibleCount > 0 &&
              totalNormalizedWeight > 0 &&
              normalizedWeights[i] !== undefined
                ? normalizedWeights[i]! / totalNormalizedWeight
                : 0;
            const slotMain =
              requiredMain <= main + 0.01 ? remaining * proportion : 0;
            const measuredChild = measure(
              child,
              horizontal ? slotMain : spacer ? 0 : w,
              horizontal ? (spacer ? 0 : h) : slotMain,
              `${path}/${childKey}`,
              horizontal,
              `${spacePath}/${encodeSpaceSegment(childKey)}`,
              diagnosticSpace,
            );
            if (horizontal) {
              measuredChild.width = slotMain;
            } else {
              measuredChild.height = slotMain;
            }
            capBoundaryWrappers(measuredChild, slotMain, horizontal);
            if (options.inspection) {
              measuredChild.allocatedSlotMain = slotMain;
            }
            return measuredChild;
          });
        }
        const widths = m.children.map((c) => c.width),
          heights = m.children.map((c) => c.height);
        m.width = horizontal
          ? widths.reduce((a, b) => a + b, 0) +
            gap * Math.max(0, widths.length - 1)
          : Math.max(0, ...widths);
        m.height =
          !horizontal && !overlay
            ? heights.reduce((a, b) => a + b, 0) +
              gap * Math.max(0, heights.length - 1)
            : Math.max(0, ...heights);
      }
      if (m.width > w + 0.01 || m.height > h + 0.01) {
        warnings.push(
          `${path}: content exceeds offered bounds at localTime=${time}`,
        );
        diagnostics.push({
          code: "offered-size-overflow",
          severity: "warning",
          ...(m.node.key ? { id: m.node.key } : {}),
          path,
          localTime: time,
          space: diagnosticSpace,
          message: `Content exceeds the offered bounds at localTime=${time}.`,
          bounds: { x: 0, y: 0, width: w, height: h },
          excess: {
            width: Math.max(0, m.width - w),
            height: Math.max(0, m.height - h),
          },
        });
      }
      return m;
    } catch (error) {
      throw Error(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  function place(
    m: Measured,
    x: number,
    y: number,
    transform: Transform,
    opacity: number,
    drawList = commands,
    isolationDepth = depth,
    inheritedCorrections: readonly string[] = [],
    allocatedSlot?: Bounds,
  ): LayoutNode {
    const s = m.node.spec;
    let [sx, sy, tx, ty] = transform;
    if (s.kind === "offset") {
      tx += resolveNumber(s.x, time) * sx;
      ty += resolveNumber(s.y, time) * sy;
    }
    if (s.kind === "scale") {
      const ax = x + m.width * s.anchor[0],
        ay = y + m.height * s.anchor[1];
      if (!s.anchor.every(Number.isFinite))
        throw Error(`${m.path}: scale anchor must be finite.`);
      const vx = resolveNumber(s.x, time),
        vy = resolveNumber(s.y, time);
      tx += sx * ax * (1 - vx);
      ty += sy * ay * (1 - vy);
      sx *= vx;
      sy *= vy;
    }
    if (s.kind === "opacity") {
      const value = resolveNumber(s.value, time);
      if (value < 0 || value > 1)
        throw Error(`${m.path}: opacity must be between 0 and 1.`);
      opacity *= value;
    }
    const current: Transform = [sx, sy, tx, ty];
    const bounds = { x, y, width: m.width, height: m.height };
    // One node ID per placed node, and one command ID per command that is really pushed. The
    // owner is the node whose `place()` emits the command, never resolved from the path.
    const nodeId = counter ? counter.next++ : undefined;
    const nodeStamp =
      nodeId !== undefined ? { inspectionId: nodeId } : noIdentity;
    // The declared IDs' poses must land on every paint of their chain, or a background and
    // its content drift apart mid-transition. `correctionIds` carries that ordered scope;
    // `matchId` and `sharedId` stay the matching identity, which is why a wrapper ID can
    // correct the content without becoming a second matching target.
    // Every paint keeps its own candidate list. Suppressing descendants here would be wrong:
    // a surface may carry candidates that this transition does not supply, while a descendant
    // is matched. The renderer suppresses a subtree only when the surface actually resolves a
    // matrix, which keeps the no-double-transform guarantee without guessing at layout time.
    const corrections = correctionCandidates(m, inheritedCorrections);
    const stamp = corrections.length ? { correctionIds: corrections } : {};
    // Painted before every other command of this node, on the wrapper's own measured
    // bounds, which for a background wrapper are also the content's layout bounds.
    if (s.kind === "background")
      drawList.push({
        kind: "box",
        path: m.path,
        ...(m.node.key ? { matchId: m.node.key } : {}),
        ...stamp,
        ...commandIdentity(counter, nodeId, "background"),
        bounds,
        transform: current,
        opacity,
        paintRole: "background",
        fill: s.style.fill ?? theme.colors.accent ?? theme.textColor,
        radius: s.style.radius ?? 0,
        stroke: s.style.stroke,
        strokeWidth: s.style.strokeWidth ?? 0,
      });
    if (s.kind === "clip") {
      if (isolationDepth >= 32)
        throw Error(`${m.path}: Clip nesting exceeds 32 levels.`);
      const paints: DrawCommand[] = [];
      const childSlot = allocatedSlot
        ? { x: 0, y: 0, width: m.width, height: m.height }
        : undefined;
      // Clip content is placed at this clip's local origin, so its geometry belongs to a
      // clip-local space rather than the parent's.
      const clipped = fillClipSpace(
        place(
          m.children[0],
          0,
          0,
          [1, 1, 0, 0],
          1,
          paints,
          isolationDepth + 1,
          [],
          childSlot,
        ),
        `${m.spacePath}/clip`,
      );
      const tree: LayoutNode = {
        path: m.path,
        kind: s.kind,
        bounds,
        transform: current,
        children: [clipped],
        ...(m.node.key ? { id: m.node.key } : {}),
        ...nodeStamp,
        ...(m.offeredSize ? { offeredSize: m.offeredSize } : {}),
        ...(allocatedSlot ? { allocatedSlot } : {}),
        // The child is measured in clip-local space, which this node's `bounds` do not share,
        // so no content aggregates here or on the ancestors that hold this clip.
      };
      if (m.width > 0 && m.height > 0)
        drawList.push({
          kind: "composition",
          path: m.path,
          sharedId: m.node.key,
          ...stamp,
          ...commandIdentity(counter, nodeId, "surface"),
          // Shape comes from the clip spec. A mask outline cannot tell rect from circle.
          ...(counter
            ? { inspectionSurface: clipInspectionSurface(s.shape) }
            : {}),
          bounds,
          transform: current,
          opacity,
          mask:
            s.shape.shape === "image"
              ? undefined
              : clipOutline(s.shape, m.width, m.height),
          imageMask: s.shape.shape === "image" ? s.shape : undefined,
          maskFillRule: s.shape.shape === "path" ? s.shape.fillRule : "nonzero",
          frame: { tree: clipped, commands: paints, warnings: [] },
        });
      return tree;
    }
    if (s.kind === "group") {
      if (isolationDepth >= 32)
        throw Error(`${m.path}: Group nesting exceeds 32 levels.`);
      const paints: DrawCommand[] = [];
      const childSlot = allocatedSlot
        ? { x, y, width: m.width, height: m.height }
        : undefined;
      const children = m.children.map((child) =>
        place(
          child,
          x,
          y,
          current,
          1,
          paints,
          isolationDepth + 1,
          [],
          childSlot,
        ),
      );
      const groupContent = options.inspection
        ? contentUnion(children)
        : undefined;
      const tree: LayoutNode = {
        path: m.path,
        kind: s.kind,
        bounds,
        transform: current,
        children,
        ...(m.node.key ? { id: m.node.key } : {}),
        ...nodeStamp,
        ...(m.offeredSize ? { offeredSize: m.offeredSize } : {}),
        ...(allocatedSlot ? { allocatedSlot } : {}),
        // Children sit in this node's own coordinates, so they aggregate like a container's.
        ...(groupContent ? { contentBounds: groupContent } : {}),
      };
      if (paints.length) {
        // Paint bounds, not layout bounds, preserve offset/scaled children without clipping.
        const extents = paints.map((paint) => {
          const b = paint.bounds,
            [px, py, dx, dy] = paint.transform;
          return [
            b.x * px + dx,
            b.y * py + dy,
            (b.x + b.width) * px + dx,
            (b.y + b.height) * py + dy,
          ];
        });
        const left = Math.min(...extents.flatMap((b) => [b[0], b[2]]));
        const top = Math.min(...extents.flatMap((b) => [b[1], b[3]]));
        const width = Math.max(...extents.flatMap((b) => [b[0], b[2]])) - left;
        const height = Math.max(...extents.flatMap((b) => [b[1], b[3]])) - top;
        if (width > 0 && height > 0)
          drawList.push({
            kind: "group",
            path: m.path,
            sharedId: m.node.key,
            ...stamp,
            ...commandIdentity(counter, nodeId, "surface"),
            ...(counter
              ? { inspectionSurface: groupInspectionSurface() }
              : {}),
            bounds: { x: left, y: top, width, height },
            transform: [1, 1, 0, 0],
            opacity,
            frame: {
              tree,
              commands: paints,
              warnings: [],
              camera: evaluateCamera(
                { x: left, y: top, anchor: [0, 0] },
                time,
                [width, height],
              ),
            },
          });
      }
      return tree;
    }
    if (m.composition)
      drawList.push({
        kind: "composition",
        sharedId: m.node.key,
        ...stamp,
        ...commandIdentity(counter, nodeId, "surface"),
        ...(counter
          ? { inspectionSurface: compositionInspectionSurface() }
          : {}),
        path: m.path,
        bounds,
        transform: current,
        opacity,
        frame: m.composition,
        overlay: m.overlay,
      });
    // Content paint emitted by this node itself starts here; a leaf only carries content
    // bounds when one of these paints really exists in this evaluation.
    const ownPaintStart = drawList.length;
    if (
      s.kind === "image" ||
      (s.kind === "video" &&
        (options.context?.time ?? time) >= s.clip.start &&
        (options.context?.time ?? time) <= s.clip.start + s.clip.duration)
    )
      drawList.push({
        kind: "media",
        ...stamp,
        ...commandIdentity(counter, nodeId, "content"),
        crop: s.style.crop
          ? [
              resolveNumber(s.style.crop.x ?? 0.5, time),
              resolveNumber(s.style.crop.y ?? 0.5, time),
              resolveNumber(s.style.crop.zoom ?? 1, time),
            ]
          : undefined,
        source: s,
        time: options.context?.time ?? time,
        sharedId: m.node.key,
        path: m.path,
        bounds,
        transform: current,
        opacity,
      });
    if (s.kind === "circle" || s.kind === "line") {
      const geometry = m.shape!;
      const fill =
        s.kind === "circle"
          ? s.style.strokeOnly
            ? undefined
            : (s.style.fill ??
              (s.style.stroke
                ? undefined
                : (theme.colors.accent ?? theme.textColor)))
          : (s.style.color ?? theme.textColor);
      for (const [outline, color] of [
        [geometry.fill, fill],
        [
          geometry.stroke,
          s.kind === "circle"
            ? (s.style.stroke ??
              (s.style.strokeOnly
                ? (theme.colors.accent ?? theme.textColor)
                : undefined))
            : undefined,
        ],
      ] as const)
        if (outline.length && color) {
          drawList.push({
            kind: "path",
            sharedId: m.node.key,
            ...stamp,
            ...commandIdentity(counter, nodeId, "content"),
            path: m.path,
            bounds,
            transform: current,
            opacity,
            outline,
            data: pathData(outline),
            fill: color,
            fillRule: "nonzero",
          });
        }
    }
    if (s.kind === "path")
      drawList.push({
        kind: "path",
        path: m.path,
        sharedId: m.node.key,
        ...stamp,
        ...commandIdentity(counter, nodeId, "content"),
        bounds,
        transform: current,
        opacity,
        data: pathData(evaluatePath(s, time)),
        outline: evaluatePath(s, time),
        fill: s.style.fill ?? theme.textColor,
        fillRule: s.style.fillRule ?? "nonzero",
      });
    if (s.kind === "box")
      drawList.push({
        kind: "box",
        sharedId: m.node.key,
        ...stamp,
        ...commandIdentity(counter, nodeId, "content"),
        path: m.path,
        bounds,
        transform: current,
        opacity,
        fill: s.style.fill ?? theme.colors.accent ?? theme.textColor,
        radius: s.style.radius ?? 0,
        stroke: s.style.stroke,
        strokeWidth: s.style.strokeWidth ?? 0,
      });
    if (m.text)
      drawList.push({
        kind: "text",
        sharedId: m.node.key,
        ...stamp,
        ...commandIdentity(counter, nodeId, "content"),
        path: m.path,
        bounds,
        transform: current,
        opacity,
        text: m.text,
      });
    let cursor = 0;
    const ownContent = options.inspection && drawList.length > ownPaintStart;
    const children = m.children.map((child) => {
      let cx = x,
        cy = y;
      let childSlot: Bounds | undefined;
      if (s.kind === "padding") {
        cx += s.left;
        cy += s.top;
        if (allocatedSlot) {
          childSlot = {
            x: allocatedSlot.x + s.left,
            y: allocatedSlot.y + s.top,
            width: Math.max(0, allocatedSlot.width - s.left - s.right),
            height: Math.max(0, allocatedSlot.height - s.top - s.bottom),
          };
        }
      } else if (s.kind === "frame") {
        const fw =
          s.width === undefined || s.width === "fill"
            ? (allocatedSlot ? allocatedSlot.width : m.width)
            : positive(s.width, "Frame width");
        const fh =
          s.height === undefined || s.height === "fill"
            ? (allocatedSlot ? allocatedSlot.height : m.height)
            : positive(s.height, "Frame height");
        cx += align(s.alignX ?? s.align, m.width - child.width);
        cy += align(s.alignY ?? s.align, m.height - child.height);
        if (allocatedSlot) {
          childSlot = {
            x,
            y,
            width: fw,
            height: fh,
          };
        }
      } else if (s.kind === "hstack") {
        const slotWidth = (allocatedSlot && child.allocatedSlotMain !== undefined)
          ? child.allocatedSlotMain
          : child.width;
        cx += cursor;
        cy += align(s.options.align ?? "center", m.height - child.height);
        if (allocatedSlot) {
          childSlot = {
            x: cx,
            y,
            width: slotWidth,
            height: m.height,
          };
        }
        cursor += child.width + (s.options.gap ?? 0);
      } else if (s.kind === "vstack") {
        const slotHeight = (allocatedSlot && child.allocatedSlotMain !== undefined)
          ? child.allocatedSlotMain
          : child.height;
        cy += cursor;
        cx += align(s.options.align ?? "center", m.width - child.width);
        if (allocatedSlot) {
          childSlot = {
            x,
            y: cy,
            width: m.width,
            height: slotHeight,
          };
        }
        cursor += child.height + (s.options.gap ?? 0);
      } else if (s.kind === "zstack" || s.kind === "group") {
        cx += align(s.options.align ?? "center", m.width - child.width);
        cy += align(s.options.align ?? "center", m.height - child.height);
        if (allocatedSlot) {
          childSlot = {
            x,
            y,
            width: m.width,
            height: m.height,
          };
        }
      } else {
        childSlot = allocatedSlot;
      }
      return place(
        child,
        cx,
        cy,
        current,
        opacity,
        drawList,
        isolationDepth,
        corrections,
        childSlot,
      );
    });
    if (m.composition) children.push(m.composition.tree);
    if (m.overlay) children.push(m.overlay.tree);
    // Opt-in content union: a leaf contributes its own layout bounds, a container the union of
    // its children. Composition roots keep their own scoped spaces, so nothing aggregates
    // across one; Clip and Group build their trees above and handle this themselves.
    const contentBounds =
      !options.inspection || s.kind === "composition"
        ? undefined
        : ownContent
          ? { ...bounds }
          : contentUnion(children);
    return {
      path: m.path,
      kind: s.kind,
      bounds,
      transform: current,
      children,
      ...(m.node.key ? { id: m.node.key } : {}),
      ...nodeStamp,
      ...(m.offeredSize ? { offeredSize: m.offeredSize } : {}),
      ...(allocatedSlot ? { allocatedSlot } : {}),
      ...(contentBounds ? { contentBounds } : {}),
    };
  }
  const rootKey = root.key ?? "root";
  const measured = measure(
    root,
    width,
    height,
    rootKey,
    undefined,
    encodeSpaceSegment(rootKey),
  );
  const rootSlot: Bounds | undefined = options.inspection
    ? { x: 0, y: 0, width, height }
    : undefined;
  return {
    tree: place(measured, 0, 0, [1, 1, 0, 0], 1, commands, depth, [], rootSlot),
    commands,
    warnings,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}
