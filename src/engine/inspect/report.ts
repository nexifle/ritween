/**
 * Whitelisted inspection JSON for `ritween inspect`
 * (docs/plans/declarative-layout-hardening.md §7 "CLI contract").
 *
 * The document is built from untrusted scene metadata: a raw Scene decides what
 * `inspect()` returns, so every field is read through an explicit whitelist and
 * checked. Two failure kinds stay distinct:
 *
 * - `InspectionReadError`: a property access or iteration threw (hostile getter,
 *   broken proxy). The scope is published as unavailable with that reason, the
 *   same way a Scene without the capability is reported.
 * - `InspectionSerializationError`: readable data violates the contract (a
 *   non-finite coordinate, a missing path). Output is rejected instead of
 *   publishing geometry a consumer could mistake for measurement.
 *
 * Only metadata is published: no GPU textures, media sources, draw command
 * outlines, or text runs. Legacy `EvaluatedFrame.tree.path` strings are kept
 * verbatim; the owning scene scope is published beside them, never merged into
 * the path.
 */
import type {
  FrameInspection,
  InspectedLayer,
  InspectionClock,
} from "../render/renderer";

/** Bumped whenever a published field changes meaning; consumers must reject unknowns. */
export const INSPECTION_SCHEMA_VERSION = 1;
/** stdout/file budget in UTF-8 bytes. Over the budget the command fails; it never truncates. */
export const MAX_INSPECTION_BYTES = 64 * 1024 * 1024;
/** Serialized documents are bounded by budget; safe limit guards against stack overflow. */
const MAX_DOCUMENT_DEPTH = 1024;
const SCOPE_PATTERN = /^(?:scene:.+|overlay)$/;
/** `,"inspectionId":` in a layout node, charged when the field is present. */
const LAYOUT_INSPECTION_ID_KEY = 16;
/** `,"paintRecords":[]` in a scene, charged when the field is present; commas are per record. */
const PAINT_RECORDS_STRUCTURE = 18;
/**
 * Work budget of one target scan: one unit per raw node entry and per children index read.
 * A work limit, not an output size — a pruned branch still costs units while publishing no bytes.
 */
const MAX_RAW_TARGET_WORK = 1_000_000;

export class InspectionReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionReadError";
  }
}
export class InspectionSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionSerializationError";
  }
}
/** Malformed target syntax; a usage error before any rendering starts. */
export class InspectionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionTargetError";
  }
}

export interface InspectionBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface InspectionSize {
  readonly width: number;
  readonly height: number;
}
/** One placed layout node. `path` is the authored per-frame path, relative to `space`. */
export interface InspectionLayoutNode {
  readonly path: string;
  readonly kind: string;
  /** Author-declared ID from `ViewNode.id()`; absent for anonymous nodes, never synthetic. */
  readonly id?: string;
  /** Coordinate space of `bounds`/`transform`. Absent means this frame's own `layout` space.
   * Clip descendants use `${clip space}/clip` and inherit it, so `allocatedSlot` is always in
   * the same space as the node's own `bounds`. */
  readonly space?: string;
  /** Raw composition path prefix for legacy warning attribution. */
  readonly warningPrefix?: string;
  /** Parent-offered dimensions at measurement time; opt-in inspection metadata. */
  readonly offeredSize?: InspectionSize;
  /** Layout slot allocated by parent container; opt-in inspection metadata. */
  readonly allocatedSlot?: InspectionBounds;
  /** Union of leaf content layout bounds in this node's own space; absent when nothing
   * aggregates there, including at Clip and Composition space boundaries. Layout geometry,
   * never paint, visibility or ink. */
  readonly contentBounds?: InspectionBounds;
  /** Identity from the frame's one evaluation counter; absent when inspection is disabled. */
  readonly inspectionId?: number;
  readonly bounds: InspectionBounds;
  readonly transform: readonly number[];
  readonly children: readonly InspectionLayoutNode[];
}
/** Paint metadata only: draw sources, outlines, text runs and frames are not serialized. */
export interface InspectionCommand {
  readonly kind: string;
  readonly path: string;
  /** Coordinate space of `bounds`/`transform`; absent means this frame's `layout` space. */
  readonly space?: string;
  readonly bounds: InspectionBounds;
  readonly transform: readonly number[];
  readonly opacity: number;
  readonly sharedId?: string;
  /** `background` for a modifier's own measured-bounds paint; content paints omit it. */
  readonly paintRole?: string;
  /** Wrapper-declared semantic target carried by that wrapper's own paint. */
  readonly matchId?: string;
  /** Command identity and the node whose `place()` emitted it; absent without inspection. */
  readonly inspection?: {
    readonly id: number;
    readonly nodeId: number;
    readonly role: "content" | "background" | "surface";
  };
  /**
   * Ordered paint-correction candidates this paint accepts, innermost declaration first.
   * A transition applies the first one it supplies, so the report can explain which scope a
   * paint actually followed. Separately bounded from `sharedId`/`matchId`, which are the
   * matching identity.
   */
  readonly correctionIds?: readonly string[];
}
export type InspectionSeverity = "warning" | "error";
/** Structured conflict; `warnings` keeps the legacy strings unchanged. */
export interface InspectionDiagnostic {
  /** Stable code, for example `offered-size-overflow` or `unavailable-inspection`. */
  readonly code: string;
  readonly severity: InspectionSeverity;
  /** Qualified scene instance (`scene:<entry id>`) or `overlay`; IDs are scoped to it. */
  readonly scope: string;
  /** Author-declared node ID. Repeats across scopes are different nodes. */
  readonly id?: string;
  /** Exact node path inside `scope`; `.` marks the scope root itself. */
  readonly path: string;
  /** Evaluation-local clock at detection plus the inspected frame's composition time. */
  readonly clock: { readonly local: number; readonly project: number };
  /** Coordinate space of `path`, `bounds`, `excess` and `deficit`. */
  readonly space: string;
  readonly message: string;
  readonly bounds?: InspectionBounds;
  readonly excess?: { readonly width: number; readonly height: number };
  readonly deficit?: number;
}
export type InspectionClockFields = InspectionClock;
export interface InspectionScene {
  /** Qualified scope: `scene:<entry id>` or `overlay`. */
  readonly scope: string;
  readonly id: string;
  readonly name: string;
  /** Project, scene-local and progress clocks of this frame. */
  readonly clock: InspectionClockFields;
  readonly inspection: "available" | "unavailable";
  /** Why inspection is unavailable. A raw Scene is never published as an empty tree. */
  readonly unavailable?: string;
  /** Named coordinate spaces this scope measures; only layout exists before G3. */
  readonly spaces: readonly string[];
  readonly tree?: InspectionLayoutNode;
  readonly commands?: readonly InspectionCommand[];
  /**
   * Absent when the provider supplies no collection at all; `[]` when it collected and found
   * nothing. Records are ideal projected top-level Box, Text, and Media draw quads in
   * `scene-target-pixels` before transition projection. A Text quad is the texture/line box,
   * not glyph ink. A Media quad is the fitted texture rectangle, not alpha, crop-UV, or ink
   * coverage. A tagged Clip or Group chain adds `surfaceProjection` for those quads:
   * rect-only and Group-only chains keep `rect-clipped-draw-quad`, and any non-rect Clip
   * publishes `outer-clipped-draw-quad`. That is still not mask pixels, fragment visibility,
   * or a GPU rounding guarantee. Composition, World, and Overlay paint stays unavailable.
   * This is not completed G3.
   */
  readonly paintRecords?: readonly InspectionPaintRecord[];
  /** Legacy `EvaluatedFrame.warnings` strings, preserved verbatim and in order. */
  readonly warnings?: readonly string[];
}
/** Matching node of an exact `--target` filter, with its ancestor context retained. */
export interface InspectionTargetResult {
  readonly scope: string;
  readonly id: string;
  readonly path: string;
  /** Total matches in the scope; more than one is rejected before this is published. */
  readonly matches: number;
}
export interface InspectionCapability {
  /** Snapshot of the last completed frame; no pixel readback. */
  readonly inspection: "structural-snapshot";
  readonly geometry: {
    /** Placed node rectangles from `evaluateView`, in that scene's layout space. */
    readonly layout: "exact-rectangle";
    /**
     * `partial`: top-level Box, Text, and Media draw quads are recorded, as their ideal projection
     * in `scene-target-pixels` before transition. A Text quad is the texture/line box, not glyph
     * ink. A Media quad is the fitted texture rectangle, not alpha, crop-UV, or pixel coverage.
     * Nothing here is final visual coverage, fragment visibility, or a GPU rounding guarantee.
     * Clip and Group leaves record an outer draw quad, not mask pixels. Composition, World,
     * and Overlay paint stays unrecorded. G3 is not complete.
     */
    readonly paint: "partial";
  };
  readonly transitions: {
    readonly projection: "unavailable";
    readonly reason: string;
  };
}
export interface InspectionDocument {
  readonly schemaVersion: number;
  readonly packageVersion: string;
  readonly project: {
    readonly name: string;
    readonly duration: number;
    readonly resolution: readonly [number, number];
  };
  /** `requested` is the exact argument; `effective` is the composition time it evaluated at. */
  readonly time: { readonly requested: number; readonly effective: number };
  readonly capability: InspectionCapability;
  readonly scenes: readonly InspectionScene[];
  readonly diagnostics: readonly InspectionDiagnostic[];
  readonly target?: InspectionTargetResult;
}
export interface InspectionTarget {
  readonly scope: string;
  readonly id: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/**
 * Describe a rejected value for an error message. `String(value)` runs an object's
 * `Symbol.toPrimitive`/`toString`, which is a non-whitelisted read of untrusted metadata,
 * so non-primitive values are named by type instead.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  return String(value);
}
/** `Array.isArray` reads the prototype slot, which a revoked proxy answers by throwing. */
function isArray(value: unknown): value is readonly unknown[] {
  return reading(() => Array.isArray(value));
}
/** Read one whitelisted property; a throwing getter reports a read error, not a crash. */
function read(target: unknown, key: string, where: string): unknown {
  if (typeof target !== "object" || target === null)
    throw new InspectionSerializationError(
      `${where} must be an object, received ${target === null ? "null" : typeof target}.`,
    );
  try {
    return (target as Record<string, unknown>)[key];
  } catch (error) {
    throw new InspectionReadError(
      `${where}.${key} could not be read: ${describe(error)}`,
    );
  }
}
/**
 * Run a task with JS built-ins that read scene metadata replaced. Scene arrays and
 * objects may be proxies whose `length`, index or iterator throws; every such access
 * must surface as {@link InspectionReadError} so one hostile scope degrades to
 * unavailable instead of failing the whole inspection.
 */
function reading<T>(task: () => T): T {
  try {
    return task();
  } catch (error) {
    if (
      error instanceof InspectionReadError ||
      error instanceof InspectionSerializationError
    )
      throw error;
    throw new InspectionReadError(
      `scene metadata could not be read: ${describe(error)}`,
    );
  }
}
export class InspectionBudget {
  readonly limit: number;
  private currentBytes = 0;

  constructor(limit = MAX_INSPECTION_BYTES) {
    this.limit = limit;
  }

  get bytes(): number {
    return this.currentBytes;
  }

  charge(amount: number): void {
    this.currentBytes += amount;
    if (this.currentBytes > this.limit) {
      throw overBudget(this.currentBytes, this.limit);
    }
  }

  chargeText(text: string): void {
    let cost = 2; // Quotes
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (
        code === 0x22 ||
        code === 0x5c ||
        (code >= 8 && code <= 10) ||
        code === 12 ||
        code === 13
      ) {
        cost += 2;
      } else if (code < 0x20) {
        cost += 6;
      } else if (code < 0x80) {
        cost += 1;
      } else if (code < 0x800) {
        cost += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cost += 4;
          index++;
        } else {
          cost += 6;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        cost += 6;
      } else {
        cost += 3;
      }
    }
    this.charge(cost);
  }
}

/**
 * Element count without trusting an array length getter. A hostile `length` reports a
 * read error; a non-integer or negative one is a malformed value.
 */
function size(value: readonly unknown[], where: string): number {
  if (!isArray(value))
    throw new InspectionSerializationError(
      `${where} must be an array, received ${typeof value}.`,
    );
  const length = reading(() => value.length);
  if (!Number.isSafeInteger(length) || length < 0)
    throw new InspectionSerializationError(
      `${where}.length must be a non-negative integer, received ${String(length)}.`,
    );
  return length;
}
/** Visit each element through one read boundary, including the index and iterator access. */
function each<T>(
  value: readonly unknown[],
  where: string,
  visit: (entry: unknown, index: number) => T,
  budget?: InspectionBudget,
): T[] {
  const count = size(value, where);
  const out: T[] = [];
  for (let index = 0; index < count; index++) {
    budget?.charge(1);
    out.push(reading(() => visit(value[index], index)));
  }
  return out;
}
function text(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): string {
  if (typeof value !== "string")
    throw new InspectionSerializationError(
      `${where} must be a string, received ${typeof value}.`,
    );
  budget?.chargeText(value);
  return value;
}
function finite(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InspectionSerializationError(
      `${where} must be a finite number, received ${describeValue(value)}.`,
    );
  budget?.charge(String(value).length);
  return value;
}
function list(value: unknown, where: string): readonly unknown[] {
  if (!isArray(value))
    throw new InspectionSerializationError(
      `${where} must be an array, received ${typeof value}.`,
    );
  return value;
}
function bounds(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): InspectionBounds {
  // `{"x":,"y":,"width":,"height":}` with the two braces, excluding the values.
  budget?.charge(30);
  return {
    x: finite(read(value, "x", where), `${where}.x`, budget),
    y: finite(read(value, "y", where), `${where}.y`, budget),
    width: finite(read(value, "width", where), `${where}.width`, budget),
    height: finite(read(value, "height", where), `${where}.height`, budget),
  };
}
function inspectionSize(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): InspectionSize {
  budget?.charge(15);
  return {
    width: finite(read(value, "width", where), `${where}.width`, budget),
    height: finite(read(value, "height", where), `${where}.height`, budget),
  };
}
function transform(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): readonly number[] {
  const count = size(list(value, where), where);
  if (count !== 4)
    throw new InspectionSerializationError(
      `${where} must have 4 entries, received ${count}.`,
    );
  budget?.charge(5);
  return each(
    list(value, where),
    where,
    (entry, index) => finite(entry, `${where}[${index}]`, budget),
    budget,
  );
}
/** Exact enum member; any other value would publish a role or accuracy the schema cannot name. */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  throw new InspectionSerializationError(
    `${where} must be ${allowed.map((entry) => `"${entry}"`).join(" or ")}, received ${describeValue(value)}.`,
  );
}
/** Inspection IDs come from one evaluation-local counter, so they are safe non-negative integers. */
function safeId(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InspectionSerializationError(
      `${where} must be a non-negative safe integer, received ${describeValue(value)}.`,
    );
  budget?.charge(String(value).length);
  return value;
}
/** `scene-target-pixels` resolution tuple: exactly two finite numbers. */
function resolutionTuple(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): readonly [number, number] {
  const entries = list(value, where);
  const count = size(entries, where);
  if (count !== 2)
    throw new InspectionSerializationError(
      `${where} must have 2 entries, received ${count}.`,
    );
  budget?.charge(3);
  return [
    finite(
      reading(() => entries[0]),
      `${where}[0]`,
      budget,
    ),
    finite(
      reading(() => entries[1]),
      `${where}[1]`,
      budget,
    ),
  ];
}
/**
 * Structural fields one target scan read from a raw node, so the targeted construction reuses
 * them instead of running the getters a second time. Values stay raw: validation and charging
 * happen at the same place as an ordinary read.
 */
interface RawNodeSnapshot {
  readonly id: unknown;
  readonly children: unknown;
  /** 0 when `children` is not an array, so the scan reads a length only where one exists. */
  readonly childCount: number;
  /** Every index the scan read, in order; construction never touches the array again. */
  readonly childValues: unknown[];
  /** True when the scan read `inspectionId`, including when the value was `undefined`. */
  readonly inspectionIdRead: boolean;
  readonly inspectionId: unknown;
  /** Raw `path`/`space` of the targeted node only; every other node reads them once on construction. */
  readonly path: unknown;
  readonly space: unknown;
  readonly matched: boolean;
}
function snapshotFor(
  snapshots: WeakMap<object, RawNodeSnapshot> | undefined,
  value: unknown,
): RawNodeSnapshot | undefined {
  return typeof value === "object" && value !== null
    ? snapshots?.get(value)
    : undefined;
}
function readNodeHeader(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
  visited?: Set<unknown>,
  snapshot?: RawNodeSnapshot,
) {
  if (typeof value === "object" && value !== null) {
    if (visited?.has(value)) {
      throw new InspectionSerializationError(
        `Layout tree ${where} contains a cycle.`,
      );
    }
    visited?.add(value);
  }
  budget?.charge(47);
  const childrenRaw = list(
    snapshot === undefined ? read(value, "children", where) : snapshot.children,
    `${where}.children`,
  );
  const id = snapshot === undefined ? read(value, "id", where) : snapshot.id;
  const space =
    snapshot?.matched === true ? snapshot.space : read(value, "space", where);
  const pathVal = text(
    snapshot?.matched === true ? snapshot.path : read(value, "path", where),
    `${where}.path`,
    budget,
  );
  const kindVal = text(read(value, "kind", where), `${where}.kind`, budget);
  const idVal = id === undefined ? undefined : text(id, `${where}.id`, budget);
  if (idVal !== undefined) budget?.charge(6);
  const spaceVal =
    space === undefined ? undefined : text(space, `${where}.space`, budget);
  if (spaceVal !== undefined) budget?.charge(9);
  const rawWarningPrefix = read(value, "warningPrefix", where);
  let warningPrefixVal: string | undefined;
  if (rawWarningPrefix !== undefined) {
    warningPrefixVal = text(rawWarningPrefix, `${where}.warningPrefix`, budget);
  }
  const rawOfferedSize = read(value, "offeredSize", where);
  let offeredSizeVal: InspectionSize | undefined;
  if (rawOfferedSize !== undefined) {
    offeredSizeVal = inspectionSize(
      rawOfferedSize,
      `${where}.offeredSize`,
      budget,
    );
  }
  const rawAllocatedSlot = read(value, "allocatedSlot", where);
  let allocatedSlotVal: InspectionBounds | undefined;
  if (rawAllocatedSlot !== undefined) {
    allocatedSlotVal = bounds(
      rawAllocatedSlot,
      `${where}.allocatedSlot`,
      budget,
    );
  }
  const rawContentBounds = read(value, "contentBounds", where);
  let contentBoundsVal: InspectionBounds | undefined;
  if (rawContentBounds !== undefined) {
    contentBoundsVal = bounds(
      rawContentBounds,
      `${where}.contentBounds`,
      budget,
    );
  }
  const rawInspectionId =
    snapshot?.inspectionIdRead === true
      ? snapshot.inspectionId
      : read(value, "inspectionId", where);
  let inspectionIdVal: number | undefined;
  if (rawInspectionId !== undefined) {
    budget?.charge(LAYOUT_INSPECTION_ID_KEY);
    inspectionIdVal = safeId(rawInspectionId, `${where}.inspectionId`, budget);
  }
  const boundsVal = bounds(
    read(value, "bounds", where),
    `${where}.bounds`,
    budget,
  );
  const transformVal = transform(
    read(value, "transform", where),
    `${where}.transform`,
    budget,
  );

  return {
    value,
    where,
    childrenRaw,
    pathVal,
    kindVal,
    idVal,
    spaceVal,
    warningPrefixVal,
    offeredSizeVal,
    allocatedSlotVal,
    contentBoundsVal,
    inspectionIdVal,
    boundsVal,
    transformVal,
  };
}

/** Construct an InspectionLayoutNode and its subtree iteratively with cycle detection. */
function constructLayoutTree(
  rootValue: unknown,
  rootWhere: string,
  budget?: InspectionBudget,
  snapshots?: WeakMap<object, RawNodeSnapshot>,
): InspectionLayoutNode {
  const visited = new Set<unknown>();

  interface StackEntry {
    header: ReturnType<typeof readNodeHeader>;
    /** Snapshotted structural fields of a target scan; absent on the untargeted path. */
    snapshot: RawNodeSnapshot | undefined;
    childIndex: number;
    childrenBuilt: InspectionLayoutNode[];
  }

  const rootSnapshot = snapshotFor(snapshots, rootValue);
  const stack: StackEntry[] = [
    {
      header: readNodeHeader(
        rootValue,
        rootWhere,
        budget,
        visited,
        rootSnapshot,
      ),
      snapshot: rootSnapshot,
      childIndex: 0,
      childrenBuilt: [],
    },
  ];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const childCount =
      top.snapshot === undefined
        ? top.header.childrenRaw.length
        : top.snapshot.childCount;

    if (top.childIndex < childCount) {
      const idx = top.childIndex++;
      budget?.charge(1);
      const childRaw =
        top.snapshot === undefined
          ? reading(() => top.header.childrenRaw[idx])
          : top.snapshot.childValues[idx];
      const childWhere = `${top.header.where}.children[${idx}]`;
      const childSnapshot = snapshotFor(snapshots, childRaw);
      stack.push({
        header: readNodeHeader(
          childRaw,
          childWhere,
          budget,
          visited,
          childSnapshot,
        ),
        snapshot: childSnapshot,
        childIndex: 0,
        childrenBuilt: [],
      });
    } else {
      stack.pop();
      const node: InspectionLayoutNode = {
        path: top.header.pathVal,
        kind: top.header.kindVal,
        ...(top.header.idVal === undefined ? {} : { id: top.header.idVal }),
        ...(top.header.spaceVal === undefined
          ? {}
          : { space: top.header.spaceVal }),
        ...(top.header.offeredSizeVal === undefined
          ? {}
          : { offeredSize: top.header.offeredSizeVal }),
        ...(top.header.allocatedSlotVal === undefined
          ? {}
          : { allocatedSlot: top.header.allocatedSlotVal }),
        ...(top.header.contentBoundsVal === undefined
          ? {}
          : { contentBounds: top.header.contentBoundsVal }),
        ...(top.header.inspectionIdVal === undefined
          ? {}
          : { inspectionId: top.header.inspectionIdVal }),
        bounds: top.header.boundsVal,
        transform: top.header.transformVal,
        children: top.childrenBuilt,
      };
      if (top.header.warningPrefixVal) {
        Object.defineProperty(node, "warningPrefix", {
          value: top.header.warningPrefixVal,
          enumerable: false,
          configurable: true,
        });
      }

      if (stack.length > 0) {
        stack[stack.length - 1].childrenBuilt.push(node);
      } else {
        return node;
      }
    }
  }

  throw new InspectionSerializationError("Failed to construct layout tree.");
}

/** One raw node on the scan stack. Matches keep this link instead of copying ancestors. */
interface RawScanFrame {
  readonly node: object;
  readonly parent: RawScanFrame | undefined;
}
interface RawTargetMatch {
  node: unknown;
  /** Parent chain is shared through `frame.parent`; copied only for the unique match. */
  frame: RawScanFrame;
  path: string;
  space?: string;
}

interface RawTargetScan {
  matches: RawTargetMatch[];
  /** Structural fields construction would otherwise read again, keyed by raw node object. */
  snapshots: WeakMap<object, RawNodeSnapshot>;
  /** Every `inspectionId` in the tree; filled only when a paint record needs owner identity. */
  ownerCounts: Map<number, number>;
}

function overTargetWork(): InspectionSerializationError {
  return new InspectionSerializationError(
    `Layout tree target scan is over its ${MAX_RAW_TARGET_WORK}-unit work limit. Discarded branches spend work units without publishing bytes, so reduce the targeted scope's node count and retry.`,
  );
}
/**
 * One bounded pass over the raw source tree: locate the target, snapshot the structural fields
 * its construction needs, and count owner identities when a paint record must be attributed.
 * Work units bound the traversal itself; they are unrelated to the output byte budget.
 */
function scanRawTargetTree(
  root: unknown,
  targetId: string,
  indexesOwners: boolean,
): RawTargetScan {
  const matches: RawTargetMatch[] = [];
  const snapshots = new WeakMap<object, RawNodeSnapshot>();
  const ownerCounts = new Map<number, number>();
  const visited = new Set<unknown>();
  let work = 0;

  interface ScanFrame {
    node: object;
    snapshot: RawNodeSnapshot;
    parent: ScanFrame | undefined;
    nextIndex: number;
  }

  const stack: ScanFrame[] = [];

  const enter = (value: unknown, parent: ScanFrame | undefined): void => {
    work += 1;
    if (work > MAX_RAW_TARGET_WORK) throw overTargetWork();
    if (typeof value !== "object" || value === null) return;
    if (visited.has(value))
      throw new InspectionSerializationError("Layout tree contains a cycle.");
    visited.add(value);

    const node = value as Record<string, unknown>;
    const id = reading(() => node.id);
    const matched = typeof id === "string" && id === targetId;
    const rawPath = matched ? reading(() => node.path) : undefined;
    const rawSpace = matched ? reading(() => node.space) : undefined;
    const rawChildren = reading(() => node.children);
    const childCount = isArray(rawChildren)
      ? size(rawChildren, "layout tree.children")
      : 0;
    const inspectionId = indexesOwners
      ? reading(() => node.inspectionId)
      : undefined;
    if (inspectionId !== undefined) {
      const ownerId = safeId(inspectionId, "layout tree.inspectionId");
      ownerCounts.set(ownerId, (ownerCounts.get(ownerId) ?? 0) + 1);
    }
    const snapshot: RawNodeSnapshot = {
      id,
      children: rawChildren,
      childCount,
      childValues: [],
      inspectionIdRead: indexesOwners,
      inspectionId,
      path: rawPath,
      space: rawSpace,
      matched,
    };
    snapshots.set(value, snapshot);
    const frame: ScanFrame = { node: value, snapshot, parent, nextIndex: 0 };
    if (matched) {
      matches.push({
        node: value,
        frame,
        path: reading(() => String(rawPath ?? "")),
        space: reading(() =>
          typeof rawSpace === "string" ? rawSpace : undefined,
        ),
      });
    }
    stack.push(frame);
  };

  enter(root, undefined);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.nextIndex >= top.snapshot.childCount) {
      stack.pop();
      continue;
    }
    const index = top.nextIndex++;
    work += 1;
    if (work > MAX_RAW_TARGET_WORK) throw overTargetWork();
    const children = top.snapshot.children as readonly unknown[];
    const child = reading(() => children[index]);
    top.snapshot.childValues.push(child);
    enter(child, top);
  }

  return { matches, snapshots, ownerCounts };
}

/** Construct only the target node subtree and its direct ancestor chain, skipping discarded siblings. */
function constructTargetedLayoutTree(
  match: RawTargetMatch,
  scope: string,
  budget?: InspectionBudget,
  snapshots?: WeakMap<object, RawNodeSnapshot>,
): InspectionLayoutNode {
  let currentChild = constructLayoutTree(
    match.node,
    `${scope}.tree.${match.path}`,
    budget,
    snapshots,
  );

  // One chain, and only after the scan has proved this is the only match.
  const ancestors: unknown[] = [];
  for (
    let cursor = match.frame.parent;
    cursor !== undefined;
    cursor = cursor.parent
  )
    ancestors.push(cursor.node);
  ancestors.reverse();
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const rawAncestor = ancestors[i];
    const where = `${scope}.tree.ancestor[${i}]`;
    const header = readNodeHeader(
      rawAncestor,
      where,
      budget,
      undefined,
      snapshotFor(snapshots, rawAncestor),
    );
    currentChild = {
      path: header.pathVal,
      kind: header.kindVal,
      ...(header.idVal === undefined ? {} : { id: header.idVal }),
      ...(header.spaceVal === undefined ? {} : { space: header.spaceVal }),
      ...(header.offeredSizeVal === undefined
        ? {}
        : { offeredSize: header.offeredSizeVal }),
      ...(header.allocatedSlotVal === undefined
        ? {}
        : { allocatedSlot: header.allocatedSlotVal }),
      ...(header.contentBoundsVal === undefined
        ? {}
        : { contentBounds: header.contentBoundsVal }),
      ...(header.inspectionIdVal === undefined
        ? {}
        : { inspectionId: header.inspectionIdVal }),
      bounds: header.boundsVal,
      transform: header.transformVal,
      children: [currentChild],
    };
    if (header.warningPrefixVal) {
      Object.defineProperty(currentChild, "warningPrefix", {
        value: header.warningPrefixVal,
        enumerable: false,
        configurable: true,
      });
    }
  }

  return currentChild;
}

/**
 * Safely check if a warning attributes to a retained node without allocating unbounded
 * slice strings on huge warning messages. Preserves JS/Unicode whitespace semantics
 * without arbitrary cutoff length.
 */
function checkWarningAttribution(
  warning: string,
  retainedPaths: Set<string>,
  maxPathLen: number,
): boolean {
  let start = 0;
  while (start < warning.length && /\s/.test(warning[start])) {
    start++;
  }

  const colonIndex = warning.indexOf(":", start);
  if (colonIndex === -1) {
    return true;
  }

  let end = colonIndex;
  while (end > start && /\s/.test(warning[end - 1])) {
    end--;
  }

  if (start === end) {
    return true;
  }

  const pathLength = end - start;
  if (pathLength > maxPathLen) {
    return false;
  }

  const path = warning.slice(start, end);
  return retainedPaths.has(path);
}

/** Collect retained paths and coordinate spaces iteratively without call stack limits. */
function collectRetained(root: InspectionLayoutNode): {
  retained: Map<string, Set<string>>;
  retainedAttributionPaths: Set<string>;
  maxRetainedPathLength: number;
  /** Inspection IDs the retained nodes carry, for attributing a paint record to its owner. */
  ownerIds: Set<number>;
} {
  const retained = new Map<string, Set<string>>();
  const retainedAttributionPaths = new Set<string>();
  const ownerIds = new Set<number>();
  let maxRetainedPathLength = 0;

  const addAttribution = (p: string) => {
    retainedAttributionPaths.add(p);
    if (p.length > maxRetainedPathLength) maxRetainedPathLength = p.length;
  };

  const stack: { node: InspectionLayoutNode; inherited: string }[] = [
    { node: root, inherited: "layout" },
  ];

  while (stack.length > 0) {
    const { node, inherited } = stack.pop()!;
    const nodeSpace = node.space ?? inherited;
    let paths = retained.get(nodeSpace);
    if (!paths) {
      paths = new Set<string>();
      retained.set(nodeSpace, paths);
    }
    paths.add(node.path);
    if (node.inspectionId !== undefined) ownerIds.add(node.inspectionId);

    addAttribution(node.path);
    if (nodeSpace !== "layout") {
      addAttribution(`${nodeSpace}/${node.path}`);
    }
    const prefix = (node as { warningPrefix?: string }).warningPrefix;
    if (prefix) {
      addAttribution(`${prefix}/${node.path}`);
    }

    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], inherited: nodeSpace });
    }
  }

  return {
    retained,
    retainedAttributionPaths,
    maxRetainedPathLength,
    ownerIds,
  };
}
/** How many nodes of a constructed scope tree carry each wanted inspection ID. */
function countOwnerIds(
  root: InspectionLayoutNode,
  wanted: ReadonlySet<number>,
): Map<number, number> {
  const counts = new Map<number, number>();
  const stack: InspectionLayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const id = node.inspectionId;
    if (id !== undefined && wanted.has(id))
      counts.set(id, (counts.get(id) ?? 0) + 1);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }
  return counts;
}
function command(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): InspectionCommand {
  budget?.charge(45);
  const sharedId = read(value, "sharedId", where);
  const matchId = read(value, "matchId", where);
  const correctionIds = read(value, "correctionIds", where);
  const paintRole = read(value, "paintRole", where);
  const space = read(value, "space", where);
  const kindVal = text(read(value, "kind", where), `${where}.kind`, budget);
  const pathVal = text(read(value, "path", where), `${where}.path`, budget);
  const spaceVal =
    space === undefined ? undefined : text(space, `${where}.space`, budget);
  if (spaceVal !== undefined) budget?.charge(9);
  const sharedIdVal =
    sharedId === undefined
      ? undefined
      : text(sharedId, `${where}.sharedId`, budget);
  if (sharedIdVal !== undefined) budget?.charge(12);
  const matchIdVal =
    matchId === undefined
      ? undefined
      : text(matchId, `${where}.matchId`, budget);
  if (matchIdVal !== undefined) budget?.charge(12);
  const correctionIdsVal =
    correctionIds === undefined
      ? undefined
      : each(
          list(correctionIds, `${where}.correctionIds`),
          `${where}.correctionIds`,
          (entry, index) =>
            text(entry, `${where}.correctionIds[${index}]`, budget),
          budget,
        );
  const paintRoleVal =
    paintRole === undefined
      ? undefined
      : text(paintRole, `${where}.paintRole`, budget);
  if (paintRoleVal !== undefined) budget?.charge(12);
  const rawInspection = read(value, "inspection", where);
  let inspectionVal: InspectionCommand["inspection"];
  if (rawInspection !== undefined) {
    budget?.charge(PAINT_INSPECTION_KEY);
    inspectionVal = paintIdentity(rawInspection, `${where}.inspection`, budget);
  }
  return {
    kind: kindVal,
    path: pathVal,
    ...(spaceVal === undefined ? {} : { space: spaceVal }),
    bounds: bounds(read(value, "bounds", where), `${where}.bounds`, budget),
    transform: transform(
      read(value, "transform", where),
      `${where}.transform`,
      budget,
    ),
    opacity: finite(read(value, "opacity", where), `${where}.opacity`, budget),
    ...(sharedIdVal === undefined ? {} : { sharedId: sharedIdVal }),
    ...(matchIdVal === undefined ? {} : { matchId: matchIdVal }),
    ...(correctionIdsVal === undefined
      ? {}
      : { correctionIds: correctionIdsVal }),
    ...(paintRoleVal === undefined ? {} : { paintRole: paintRoleVal }),
    ...(inspectionVal === undefined ? {} : { inspection: inspectionVal }),
  };
}
/**
 * Whitelisted form of one `PaintRecord` (`src/authoring/renderer.ts`): the published metadata,
 * never the record's owner objects. `bounds` is the ideal projected draw quad in scene-target
 * pixels — Box fill quad, Text texture/line box, or Media fitted texture quad, not glyph ink,
 * media alpha, crop-UV coverage, pixel visibility, or GPU rounding — and is absent exactly when
 * `accuracy` is `unavailable`. Media accuracy is only `conservative`.
 */
export type InspectionPaintRecord = {
  readonly path: string;
  /** Present only when the frame was evaluated with inspection enabled. */
  readonly inspection?: {
    readonly id: number;
    readonly nodeId: number;
    readonly role: "content" | "background" | "surface";
  };
  readonly paintRole: "content" | "background";
  readonly space: "scene-target-pixels";
  readonly resolution: readonly [number, number];
} & (
  | {
      readonly kind: "box";
      readonly accuracy: "exact-rectangle" | "conservative";
      readonly bounds: InspectionBounds;
      readonly provenance: "projected-box-draw-quad";
      readonly geometryVisible: boolean;
      readonly surfaceProjection?: InspectionSurfaceProjection;
    }
  | {
      readonly kind: "text";
      readonly accuracy: "exact-rectangle" | "conservative";
      readonly bounds: InspectionBounds;
      readonly provenance: "projected-text-draw-quad";
      readonly geometryVisible: boolean;
      readonly surfaceProjection?: InspectionSurfaceProjection;
    }
  | {
      readonly kind: "media";
      readonly accuracy: "conservative";
      readonly bounds: InspectionBounds;
      readonly provenance:
        | "projected-image-draw-quad"
        | "projected-video-draw-quad";
      readonly geometryVisible: boolean;
      readonly surfaceProjection?: InspectionSurfaceProjection;
    }
  | {
      readonly kind: string;
      readonly accuracy: "unavailable";
      readonly unsupported: string;
    }
);
/** JSON structure of a paint record minus its values, charged before the first field is read. */
const PAINT_RECORD_STRUCTURE = 65;
/** `,"inspection":` key in the outer record, charged when the field is present. */
const PAINT_INSPECTION_KEY = 14;
/** Braces and keys of the identity object, excluding its values. */
const PAINT_IDENTITY_STRUCTURE = 25;
/** `,"bounds":`, `,"provenance":` and `,"geometryVisible":`, excluding their values. */
const PAINT_GEOMETRY_STRUCTURE = 43;
/** `,"unsupported":`, excluding its value. */
const PAINT_UNAVAILABLE_STRUCTURE = 15;
/** `,"surfaceProjection":` on a geometry record, charged only when the field is present. */
const SURFACE_PROJECTION_KEY = 21;
/** `{"boundaries":[],"coverage":""}` excluding the coverage token and boundary items. */
const SURFACE_PROJECTION_BODY = 31;
/** `{"occurrenceId":,"kind":}` excluding the id digits and the quoted kind. */
const SURFACE_BOUNDARY_ITEM = 25;
/** `,"shape":""` excluding the shape token. Charged before the shape is read. */
const SURFACE_BOUNDARY_SHAPE = 11;
const SURFACE_COVERAGES = [
  "rect-clipped-draw-quad",
  "outer-clipped-draw-quad",
] as const;
const SURFACE_KINDS = ["group", "clip"] as const;
const SURFACE_SHAPES = ["rect", "rounded", "circle", "path", "image"] as const;
export type InspectionSurfaceBoundary =
  | { readonly occurrenceId: number; readonly kind: "group" }
  | {
      readonly occurrenceId: number;
      readonly kind: "clip";
      readonly shape: (typeof SURFACE_SHAPES)[number];
    };
export interface InspectionSurfaceProjection {
  /** Leaf target first. Group boundaries carry no mask shape. */
  readonly boundaries: readonly InspectionSurfaceBoundary[];
  readonly coverage: (typeof SURFACE_COVERAGES)[number];
}
function surfaceProjection(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): InspectionSurfaceProjection {
  budget?.charge(SURFACE_PROJECTION_KEY + SURFACE_PROJECTION_BODY);
  const coverage = oneOf(
    read(value, "coverage", where),
    SURFACE_COVERAGES,
    `${where}.coverage`,
  );
  budget?.charge(coverage.length);
  const rawBoundaries = list(
    read(value, "boundaries", where),
    `${where}.boundaries`,
  );
  const count = size(rawBoundaries, `${where}.boundaries`);
  if (count < 1)
    throw new InspectionSerializationError(
      `${where}.boundaries must have at least one surface.`,
    );
  const boundaries: InspectionSurfaceBoundary[] = [];
  let nonRect = false;
  for (let index = 0; index < count; index++) {
    if (index > 0) budget?.charge(1);
    budget?.charge(SURFACE_BOUNDARY_ITEM);
    const entry = reading(() => rawBoundaries[index]);
    const itemWhere = `${where}.boundaries[${index}]`;
    const occurrenceId = safeId(
      read(entry, "occurrenceId", itemWhere),
      `${itemWhere}.occurrenceId`,
      budget,
    );
    const kind = oneOf(
      read(entry, "kind", itemWhere),
      SURFACE_KINDS,
      `${itemWhere}.kind`,
    );
    budget?.charge(kind.length + 2);
    if (kind === "group") {
      if (read(entry, "shape", itemWhere) !== undefined)
        throw new InspectionSerializationError(
          `${itemWhere}.shape must be absent when kind is "group".`,
        );
      boundaries.push({ occurrenceId, kind });
      continue;
    }
    budget?.charge(SURFACE_BOUNDARY_SHAPE);
    const shape = oneOf(
      read(entry, "shape", itemWhere),
      SURFACE_SHAPES,
      `${itemWhere}.shape`,
    );
    budget?.charge(shape.length);
    if (shape !== "rect") nonRect = true;
    boundaries.push({ occurrenceId, kind, shape });
  }
  if (nonRect !== (coverage === "outer-clipped-draw-quad"))
    throw new InspectionSerializationError(
      nonRect
        ? `${where}.coverage must be "outer-clipped-draw-quad" when a clip shape is not "rect".`
        : `${where}.coverage must be "rect-clipped-draw-quad" when every clip shape is "rect".`,
    );
  return { boundaries, coverage };
}
function paintIdentity(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): NonNullable<InspectionPaintRecord["inspection"]> {
  budget?.charge(PAINT_IDENTITY_STRUCTURE);
  const idVal = safeId(read(value, "id", where), `${where}.id`, budget);
  const nodeIdVal = safeId(
    read(value, "nodeId", where),
    `${where}.nodeId`,
    budget,
  );
  const roleVal = oneOf(
    read(value, "role", where),
    ["content", "background", "surface"] as const,
    `${where}.role`,
  );
  budget?.charge(roleVal.length + 2);
  return { id: idVal, nodeId: nodeIdVal, role: roleVal };
}
/**
 * Read one raw paint record through an explicit whitelist. Every other field stays unread, so
 * an unrelated getter is never touched, and an `unavailable` record publishes `unsupported`
 * without reading or claiming bounds.
 */
export function paintRecord(
  value: unknown,
  where: string,
  budget?: InspectionBudget,
): InspectionPaintRecord {
  budget?.charge(PAINT_RECORD_STRUCTURE);
  const kindVal = text(read(value, "kind", where), `${where}.kind`, budget);
  const pathVal = text(read(value, "path", where), `${where}.path`, budget);
  const rawInspection = read(value, "inspection", where);
  let inspectionVal: InspectionPaintRecord["inspection"];
  if (rawInspection !== undefined) {
    budget?.charge(PAINT_INSPECTION_KEY);
    inspectionVal = paintIdentity(rawInspection, `${where}.inspection`, budget);
  }
  const paintRoleVal = oneOf(
    read(value, "paintRole", where),
    ["content", "background"] as const,
    `${where}.paintRole`,
  );
  budget?.charge(paintRoleVal.length + 2);
  const spaceVal = oneOf(
    read(value, "space", where),
    ["scene-target-pixels"] as const,
    `${where}.space`,
  );
  budget?.charge(spaceVal.length + 2);
  const resolutionVal = resolutionTuple(
    read(value, "resolution", where),
    `${where}.resolution`,
    budget,
  );
  const accuracyVal = oneOf(
    read(value, "accuracy", where),
    ["exact-rectangle", "conservative", "unavailable"] as const,
    `${where}.accuracy`,
  );
  budget?.charge(accuracyVal.length + 2);
  // Charge the branch before building either result, so `budget.bytes` never trails the JSON.
  budget?.charge(
    accuracyVal === "unavailable"
      ? PAINT_UNAVAILABLE_STRUCTURE
      : PAINT_GEOMETRY_STRUCTURE,
  );
  const identity = {
    kind: kindVal,
    path: pathVal,
    ...(inspectionVal === undefined ? {} : { inspection: inspectionVal }),
    paintRole: paintRoleVal,
    space: spaceVal,
    resolution: resolutionVal,
  } as const;
  if (accuracyVal === "unavailable")
    return {
      ...identity,
      accuracy: accuracyVal,
      unsupported: text(
        read(value, "unsupported", where),
        `${where}.unsupported`,
        budget,
      ),
    };
  if (kindVal !== "box" && kindVal !== "text" && kindVal !== "media")
    throw new InspectionSerializationError(
      `${where}.kind must be "box" or "text" or "media" when accuracy is "${accuracyVal}", received "${kindVal}": only top-level Box, Text, and Media draw quads have projected geometry.`,
    );
  const geometryVisibleVal = read(value, "geometryVisible", where);
  if (typeof geometryVisibleVal !== "boolean")
    throw new InspectionSerializationError(
      `${where}.geometryVisible must be a boolean, received ${typeof geometryVisibleVal}.`,
    );
  budget?.charge(geometryVisibleVal ? 4 : 5);
  // The discriminator is charged by its published length, so the longer Text token is not free.
  const geometry = {
    path: pathVal,
    ...(inspectionVal === undefined ? {} : { inspection: inspectionVal }),
    paintRole: paintRoleVal,
    space: spaceVal,
    resolution: resolutionVal,
    accuracy: accuracyVal,
    geometryVisible: geometryVisibleVal,
  };
  const rawSurface = read(value, "surfaceProjection", where);
  const surfaceProjectionVal =
    rawSurface === undefined
      ? undefined
      : surfaceProjection(rawSurface, `${where}.surfaceProjection`, budget);
  const projected =
    surfaceProjectionVal === undefined
      ? {}
      : { surfaceProjection: surfaceProjectionVal };
  if (kindVal === "media") {
    if (accuracyVal !== "conservative")
      throw new InspectionSerializationError(
        `${where}.accuracy must be "conservative" when kind is "media", received "${accuracyVal}": a media quad is the ideal texture rectangle, not proven pixel or ink coverage.`,
      );
    const provenanceVal = oneOf(
      read(value, "provenance", where),
      ["projected-image-draw-quad", "projected-video-draw-quad"] as const,
      `${where}.provenance`,
    );
    budget?.charge(provenanceVal.length + 2);
    return {
      ...geometry,
      kind: "media",
      accuracy: "conservative",
      provenance: provenanceVal,
      bounds: bounds(read(value, "bounds", where), `${where}.bounds`, budget),
      ...projected,
    };
  }
  if (kindVal === "text") {
    const provenanceVal = oneOf(
      read(value, "provenance", where),
      ["projected-text-draw-quad"] as const,
      `${where}.provenance`,
    );
    budget?.charge(provenanceVal.length + 2);
    return {
      ...geometry,
      kind: "text",
      provenance: provenanceVal,
      bounds: bounds(read(value, "bounds", where), `${where}.bounds`, budget),
      ...projected,
    };
  }
  const provenanceVal = oneOf(
    read(value, "provenance", where),
    ["projected-box-draw-quad"] as const,
    `${where}.provenance`,
  );
  budget?.charge(provenanceVal.length + 2);
  return {
    ...geometry,
    kind: "box",
    provenance: provenanceVal,
    bounds: bounds(read(value, "bounds", where), `${where}.bounds`, budget),
    ...projected,
  };
}
/**
 * Whether a targeted report may keep one raw record: its identity must name a retained node, and
 * that ID must belong to exactly one node of the full source tree. Paths and spaces are never a
 * fallback owner, so an untagged record or an orphan cannot be attributed and is dropped.
 */
function keepsPaintRecord(
  record: unknown,
  where: string,
  ownerIds: ReadonlySet<number>,
  ownerCounts: ReadonlyMap<number, number>,
): boolean {
  const raw = reading(() =>
    typeof record === "object" && record !== null
      ? (record as Record<string, unknown>).inspection
      : undefined,
  );
  if (raw === undefined) return false;
  const nodeId = safeId(
    read(raw, "nodeId", `${where}.inspection`),
    `${where}.inspection.nodeId`,
  );
  return ownerIds.has(nodeId) && ownerCounts.get(nodeId) === 1;
}
/**
 * Read one layer's `paintRecords` collection. Absent stays absent, an empty array stays `[]`, and
 * every kept record is serialized through {@link paintRecord} instead of being cloned. The field
 * and brackets are charged before any element is visited. After the first retained record, the
 * next comma is checked before that candidate's index or identity getter and charged only if the
 * candidate is retained, so a filtered record never pays a separator.
 * `count` is the length the caller already read through the shared array boundary.
 */
function readPaintRecords(
  entries: readonly unknown[],
  where: string,
  count: number,
  budget: InspectionBudget | undefined,
  keeps: (record: unknown, where: string) => boolean,
): InspectionPaintRecord[] {
  budget?.charge(PAINT_RECORDS_STRUCTURE);
  const out: InspectionPaintRecord[] = [];
  for (let index = 0; index < count; index++) {
    const separator = out.length > 0;
    if (separator && budget !== undefined && budget.bytes >= budget.limit)
      throw overBudget(budget.bytes + 1, budget.limit);
    const recordWhere = `${where}[${index}]`;
    const rawRecord = reading(() => entries[index]);
    if (!keeps(rawRecord, recordWhere)) continue;
    if (separator) budget?.charge(1);
    out.push(reading(() => paintRecord(rawRecord, recordWhere, budget)));
  }
  return out;
}
function severity(value: unknown, where: string): InspectionSeverity {
  if (value === "warning" || value === "error") return value;
  throw new InspectionSerializationError(
    `${where} must be "warning" or "error", received ${describeValue(value)}.`,
  );
}
/** Structured diagnostics an authoring frame emits beside its legacy warning strings. */
function diagnostics(
  value: unknown,
  scope: string,
  project: number,
  budget?: InspectionBudget,
): InspectionDiagnostic[] {
  if (value === undefined) return [];
  const entries = list(value, `${scope}.diagnostics`);
  return each(
    entries,
    `${scope}.diagnostics`,
    (entry, index) => {
      budget?.charge(78);
      const where = `${scope}.diagnostics[${index}]`;
      const id = read(entry, "id", where);
      const rawBounds = read(entry, "bounds", where);
      const excess = read(entry, "excess", where);
      const deficit = read(entry, "deficit", where);
      const codeVal = text(read(entry, "code", where), `${where}.code`, budget);
      const severityVal = severity(
        read(entry, "severity", where),
        `${where}.severity`,
      );
      budget?.charge(severityVal.length + 2);
      budget?.chargeText(scope);
      const idVal =
        id === undefined ? undefined : text(id, `${where}.id`, budget);
      if (idVal !== undefined) budget?.charge(6);
      const pathVal = text(read(entry, "path", where), `${where}.path`, budget);
      const localTime = finite(
        read(entry, "localTime", where),
        `${where}.localTime`,
        budget,
      );
      budget?.charge(String(project).length);
      const spaceVal = text(
        read(entry, "space", where),
        `${where}.space`,
        budget,
      );
      const messageVal = text(
        read(entry, "message", where),
        `${where}.message`,
        budget,
      );
      return {
        code: codeVal,
        severity: severityVal,
        scope,
        ...(idVal === undefined ? {} : { id: idVal }),
        path: pathVal,
        clock: { local: localTime, project },
        space: spaceVal,
        message: messageVal,
        ...(rawBounds === undefined
          ? {}
          : { bounds: bounds(rawBounds, `${where}.bounds`, budget) }),
        ...(excess === undefined
          ? {}
          : {
              excess: {
                width: finite(
                  read(excess, "width", `${where}.excess`),
                  `${where}.excess.width`,
                  budget,
                ),
                height: finite(
                  read(excess, "height", `${where}.excess`),
                  `${where}.excess.height`,
                  budget,
                ),
              },
            }),
        ...(deficit === undefined
          ? {}
          : { deficit: finite(deficit, `${where}.deficit`, budget) }),
      };
    },
    budget,
  );
}
interface LayerContext {
  readonly scope: string;
  readonly id: string;
  readonly name: string;
  readonly clock: InspectionClockFields;
}
function unavailableScene(
  context: LayerContext,
  reason: string,
): { scene: InspectionScene; diagnostics: InspectionDiagnostic[] } {
  return {
    scene: {
      scope: context.scope,
      id: context.id,
      name: context.name,
      clock: context.clock,
      inspection: "unavailable",
      unavailable: reason,
      spaces: [],
    },
    diagnostics: [
      {
        code: "unavailable-inspection",
        severity: "warning",
        scope: context.scope,
        path: ".",
        clock: { local: context.clock.localTime, project: context.clock.time },
        space: "layout",
        message: reason,
      },
    ],
  };
}
/** Read one layer inside the read-error boundary: hostile data degrades to unavailable. */
function inspectLayer(
  layer: InspectedLayer,
  context: LayerContext,
  options?: {
    budget?: InspectionBudget;
    target?: InspectionTarget;
  },
): {
  scene: InspectionScene;
  diagnostics: InspectionDiagnostic[];
  targetMatchInfo?: { path: string };
} {
  if (layer.frame === undefined)
    return unavailableScene(context, layer.unavailable);
  const budget = options?.budget;
  const isTargetedScope =
    options?.target && options.target.scope === context.scope;
  const isOtherScope =
    options?.target && options.target.scope !== context.scope;

  if (isOtherScope) {
    return {
      scene: {
        scope: context.scope,
        id: context.id,
        name: context.name,
        clock: context.clock,
        inspection: "available",
        spaces: [],
        tree: {
          path: "root",
          kind: "skipped",
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          transform: [1, 1, 0, 0],
          children: [],
        },
        commands: [],
        warnings: [],
      },
      diagnostics: [],
    };
  }

  try {
    const frame = layer.frame;
    budget?.charge(150);
    budget?.chargeText(context.scope);
    budget?.chargeText(context.id);
    budget?.chargeText(context.name);

    const rawTree = read(frame, "tree", context.scope);
    // Read once: a targeted scope needs the collection's length before the scan to know whether
    // owner indexing is worth it at all, and every scope serializes the same array later.
    const rawPaintRecords = read(frame, "paintRecords", context.scope);
    const paintRecordsWhere = `${context.scope}.paintRecords`;
    const paintEntries =
      rawPaintRecords === undefined
        ? undefined
        : list(rawPaintRecords, paintRecordsWhere);
    const paintRecordsCount =
      paintEntries === undefined ? 0 : size(paintEntries, paintRecordsWhere);

    let tree: InspectionLayoutNode;
    let targetMatchInfo: { path: string } | undefined;
    let rawOwnerCounts = new Map<number, number>();

    if (isTargetedScope && options?.target) {
      const scan = scanRawTargetTree(
        rawTree,
        options.target.id,
        paintRecordsCount > 0,
      );
      const matches = scan.matches;
      if (matches.length === 0) {
        throw new InspectionTargetError(
          `No node has ID "${options.target.id}" in ${context.scope}. Targets match authored ViewNode.id() values; anonymous nodes cannot be targeted.`,
        );
      }
      if (matches.length > 1) {
        throw new InspectionTargetError(
          `${matches.length} nodes have ID "${options.target.id}" in ${context.scope}: ${matches.map((m) => `${m.space ?? "layout"}:${m.path}`).join(", ")}. IDs must be unique inside one scope.`,
        );
      }
      const match = matches[0];
      targetMatchInfo = { path: match.path };
      tree = constructTargetedLayoutTree(
        match,
        context.scope,
        budget,
        scan.snapshots,
      );
      rawOwnerCounts = scan.ownerCounts;
    } else {
      tree = constructLayoutTree(rawTree, `${context.scope}.tree`, budget);
    }

    const {
      retained,
      retainedAttributionPaths,
      maxRetainedPathLength,
      ownerIds,
    } = collectRetained(tree);

    const keepsCandidate = (candidatePath: string, candidateSpace?: string) => {
      if (!isTargetedScope) return true;
      const space = candidateSpace ?? "layout";
      return retained.get(space)?.has(candidatePath) === true;
    };

    const rawCommands = list(
      read(frame, "commands", context.scope),
      `${context.scope}.commands`,
    );
    const commandsCount = size(rawCommands, `${context.scope}.commands`);
    const commands: InspectionCommand[] = [];
    for (let index = 0; index < commandsCount; index++) {
      const rawCmd = reading(() => rawCommands[index]);
      const cmdPath = reading(() =>
        typeof rawCmd === "object" && rawCmd !== null
          ? (rawCmd as Record<string, unknown>).path
          : undefined,
      );
      const cmdSpace = reading(() =>
        typeof rawCmd === "object" && rawCmd !== null
          ? (rawCmd as Record<string, unknown>).space
          : undefined,
      );
      if (
        isTargetedScope &&
        typeof cmdPath === "string" &&
        !keepsCandidate(
          cmdPath,
          typeof cmdSpace === "string" ? cmdSpace : undefined,
        )
      ) {
        continue;
      }
      budget?.charge(1);
      commands.push(
        reading(() =>
          command(rawCmd, `${context.scope}.commands[${index}]`, budget),
        ),
      );
    }

    const rawWarnings = list(
      read(frame, "warnings", context.scope),
      `${context.scope}.warnings`,
    );
    const warningsCount = size(rawWarnings, `${context.scope}.warnings`);
    const warnings: string[] = [];
    for (let index = 0; index < warningsCount; index++) {
      const rawWarning = reading(() => rawWarnings[index]);
      if (typeof rawWarning === "string" && isTargetedScope) {
        if (
          !checkWarningAttribution(
            rawWarning,
            retainedAttributionPaths,
            maxRetainedPathLength,
          )
        ) {
          continue;
        }
      }
      budget?.charge(1);
      warnings.push(
        reading(() =>
          text(rawWarning, `${context.scope}.warnings[${index}]`, budget),
        ),
      );
    }

    const rawDiagnostics = read(frame, "diagnostics", context.scope);
    let layerDiagnostics: InspectionDiagnostic[] = [];
    if (rawDiagnostics !== undefined) {
      const diagEntries = list(rawDiagnostics, `${context.scope}.diagnostics`);
      const diagCount = size(diagEntries, `${context.scope}.diagnostics`);
      for (let index = 0; index < diagCount; index++) {
        const rawDiag = reading(() => diagEntries[index]);
        const diagPath = reading(() =>
          typeof rawDiag === "object" && rawDiag !== null
            ? (rawDiag as Record<string, unknown>).path
            : undefined,
        );
        const diagSpace = reading(() =>
          typeof rawDiag === "object" && rawDiag !== null
            ? (rawDiag as Record<string, unknown>).space
            : undefined,
        );
        if (
          isTargetedScope &&
          typeof diagPath === "string" &&
          !keepsCandidate(
            diagPath,
            typeof diagSpace === "string" ? diagSpace : undefined,
          )
        ) {
          continue;
        }
        budget?.charge(1);
        layerDiagnostics.push(
          ...diagnostics([rawDiag], context.scope, context.clock.time, budget),
        );
      }
    }

    let records: InspectionPaintRecord[] | undefined;
    if (paintEntries !== undefined) {
      records = readPaintRecords(
        paintEntries,
        paintRecordsWhere,
        paintRecordsCount,
        budget,
        isTargetedScope
          ? (record, recordWhere) =>
              keepsPaintRecord(record, recordWhere, ownerIds, rawOwnerCounts)
          : () => true,
      );
    }

    return {
      scene: {
        scope: context.scope,
        id: context.id,
        name: context.name,
        clock: context.clock,
        inspection: "available",
        spaces: collectSpaces(tree),
        tree,
        commands,
        ...(records === undefined ? {} : { paintRecords: records }),
        warnings,
      },
      diagnostics: layerDiagnostics,
      targetMatchInfo,
    };
  } catch (error) {
    if (error instanceof InspectionReadError)
      return unavailableScene(
        context,
        `${context.name} inspection failed: ${error.message}`,
      );
    throw error;
  }
}
export function buildInspectionDocument(options: {
  packageVersion: string;
  project: {
    readonly name: string;
    readonly duration: number;
    readonly resolution: readonly [number, number];
  };
  frame: FrameInspection;
  target?: InspectionTarget;
  limit?: number;
}): InspectionDocument {
  const budget = new InspectionBudget(options.limit ?? MAX_INSPECTION_BYTES);
  budget.charge(300);
  budget.chargeText(options.packageVersion);
  budget.chargeText(options.project.name);

  const { frame, target } = options;
  const scenes: InspectionScene[] = [];
  const all: InspectionDiagnostic[] = [];
  let targetResult: InspectionTargetResult | undefined;

  frame.scenes.forEach((inspected) => {
    const built = inspectLayer(
      inspected,
      {
        scope: `scene:${inspected.id}`,
        id: inspected.id,
        name: inspected.name,
        clock: {
          time: inspected.time,
          localTime: inspected.localTime,
          progress: inspected.progress,
        },
      },
      { budget, target },
    );
    scenes.push(built.scene);
    all.push(...built.diagnostics);
    if (built.targetMatchInfo && target) {
      targetResult = {
        scope: target.scope,
        id: target.id,
        path: built.targetMatchInfo.path,
        matches: 1,
      };
    }
  });
  if (frame.overlay) {
    const built = inspectLayer(
      frame.overlay,
      {
        scope: "overlay",
        id: "overlay",
        name: "Project overlay",
        clock: {
          time: frame.overlay.time,
          localTime: frame.overlay.localTime,
          progress: frame.overlay.progress,
        },
      },
      { budget, target },
    );
    scenes.push(built.scene);
    all.push(...built.diagnostics);
    if (built.targetMatchInfo && target) {
      targetResult = {
        scope: target.scope,
        id: target.id,
        path: built.targetMatchInfo.path,
        matches: 1,
      };
    }
  }
  const targetScene = target
    ? scenes.find((s) => s.scope === target.scope)
    : undefined;
  const document: InspectionDocument = {
    schemaVersion: INSPECTION_SCHEMA_VERSION,
    packageVersion: options.packageVersion,
    project: {
      name: options.project.name,
      duration: options.project.duration,
      resolution: options.project.resolution,
    },
    time: { requested: frame.requestedTime, effective: frame.effectiveTime },
    capability: {
      inspection: "structural-snapshot",
      geometry: { layout: "exact-rectangle", paint: "partial" },
      transitions: {
        projection: "unavailable",
        reason:
          "Top-level Box and Text draw quads, plus Media texture quads, are ideal pre-transition projections in scene-target pixels, not glyph ink, media alpha, fragment visibility, or GPU rounding. A Media quad stays conservative after contain, cover, or crop; crop UVs do not prove ink. A tagged Clip or Group chain records the outer draw quad, not mask pixels or fragment coverage. Composition, World, Overlay, and transition output stay unavailable; G3 is not complete. Inspect a non-overlapping time for exact results.",
      },
    },
    scenes: targetScene ? [targetScene] : scenes,
    diagnostics: all,
    ...(targetResult ? { target: targetResult } : {}),
  };
  return target ? applyInspectionTarget(document, target) : document;
}
/** Parse `<scope>#<node id>`; scope is `scene:<entry id>` or `overlay`. */
export function parseInspectionTarget(source: string): InspectionTarget {
  const separator = source.lastIndexOf("#");
  if (separator < 1 || separator === source.length - 1)
    throw new InspectionTargetError(
      `Target must be SCOPE#ID, for example scene:main#card or overlay#hud. Received "${source}".`,
    );
  const scope = source.slice(0, separator);
  const id = source.slice(separator + 1);
  if (!SCOPE_PATTERN.test(scope))
    throw new InspectionTargetError(
      `Target scope must be scene:<entry id> or overlay. Received "${scope}".`,
    );
  if (/\s/.test(id))
    throw new InspectionTargetError(
      `Target ID must not contain whitespace. Received "${id}".`,
    );
  return { scope, id };
}
/** Every coordinate space the tree actually uses, in first-seen order. */
function collectSpaces(root: InspectionLayoutNode): string[] {
  const found: string[] = [];
  const stack: InspectionLayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const space = node.space ?? "layout";
    if (!found.includes(space)) found.push(space);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }
  return found;
}
/** Nodes carrying this authored ID. Synthetic path segments never match. */
function matches(
  root: InspectionLayoutNode,
  id: string,
): InspectionLayoutNode[] {
  const found: InspectionLayoutNode[] = [];
  const stack: InspectionLayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) found.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }
  return found;
}
/**
 * Ancestor chain from the root down to `match`, keeping the matched node's subtree.
 * Bounded iterative traversal: never overflows call stack.
 */
function prune(
  root: InspectionLayoutNode,
  match: InspectionLayoutNode,
): InspectionLayoutNode | undefined {
  if (root === match) return root;

  const stack: {
    node: InspectionLayoutNode;
    ancestors: InspectionLayoutNode[];
  }[] = [{ node: root, ancestors: [] }];
  let matchAncestors: InspectionLayoutNode[] | undefined;

  while (stack.length > 0) {
    const { node, ancestors } = stack.pop()!;
    if (node === match) {
      matchAncestors = ancestors;
      break;
    }
    const nextAncestors = [...ancestors, node];
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], ancestors: nextAncestors });
    }
  }

  if (!matchAncestors) return undefined;

  let current: InspectionLayoutNode = match;
  for (let i = matchAncestors.length - 1; i >= 0; i--) {
    const ancestor = matchAncestors[i];
    current = {
      ...ancestor,
      children: [current],
    };
    const prefix = (ancestor as { warningPrefix?: string }).warningPrefix;
    if (prefix) {
      Object.defineProperty(current, "warningPrefix", {
        value: prefix,
        enumerable: false,
        configurable: true,
      });
    }
  }
  return current;
}
/** Whether a path is the target or one of its descendants inside the same space. */
function within(path: string, target: string, separator = "/"): boolean {
  return path === target || path.startsWith(`${target}${separator}`);
}
/**
 * Keep the selected scope, the ancestor chain down to the target, the target's own
 * subtree, and only the commands, warnings and diagnostics that belong to the
 * retained nodes. Diagnostics inside the target subtree are retained, so
 * `--fail-on error` cannot miss an error that is still displayed. Each
 * `(space, path)` is narrowed independently because a nested world reuses its
 * authored paths under a different space.
 */
export function applyInspectionTarget(
  document: InspectionDocument,
  target: InspectionTarget | undefined,
): InspectionDocument {
  if (!target) return document;
  if (
    document.target &&
    document.target.scope === target.scope &&
    document.target.id === target.id &&
    document.scenes.length === 1 &&
    document.scenes[0].scope === target.scope
  ) {
    return document;
  }
  const scene = document.scenes.find((entry) => entry.scope === target.scope);
  if (!scene)
    throw new InspectionTargetError(
      `No inspected scope "${target.scope}". Available: ${document.scenes.map((entry) => entry.scope).join(", ") || "none"}.`,
    );
  if (!scene.tree)
    throw new InspectionTargetError(
      `Scope "${target.scope}" has no layout tree to target: ${scene.unavailable ?? "inspection is unavailable"}`,
    );
  const found = matches(scene.tree, target.id);
  if (!found.length)
    throw new InspectionTargetError(
      `No node has ID "${target.id}" in ${target.scope}. Targets match authored ViewNode.id() values; anonymous nodes cannot be targeted.`,
    );
  if (found.length > 1)
    throw new InspectionTargetError(
      `${found.length} nodes have ID "${target.id}" in ${target.scope}: ${found.map((node) => `${node.space ?? "layout"}:${node.path}`).join(", ")}. IDs must be unique inside one scope.`,
    );
  const match = found[0];
  const tree = prune(scene.tree, match)!;

  const {
    retained,
    retainedAttributionPaths,
    maxRetainedPathLength,
    ownerIds,
  } = collectRetained(tree);

  const keepsEntry = (
    candidate: { space?: string; path: string },
    defaultSpace = "layout",
  ) =>
    retained.get(candidate.space ?? defaultSpace)?.has(candidate.path) === true;
  const commands = (scene.commands ?? []).filter((entry) =>
    keepsEntry(entry, "layout"),
  );
  const diagnostics = document.diagnostics.filter(
    (entry) => entry.scope === target.scope && keepsEntry(entry, "layout"),
  );

  const warnings = (scene.warnings ?? []).filter((warning) =>
    checkWarningAttribution(
      warning,
      retainedAttributionPaths,
      maxRetainedPathLength,
    ),
  );
  // Uniqueness is decided on the full tree, before `prune` drops the twin branches.
  const ownerCounts = scene.paintRecords?.length
    ? countOwnerIds(scene.tree, ownerIds)
    : undefined;
  const records =
    scene.paintRecords === undefined
      ? undefined
      : scene.paintRecords.filter((record) => {
          const nodeId = record.inspection?.nodeId;
          return (
            nodeId !== undefined &&
            ownerIds.has(nodeId) &&
            ownerCounts?.get(nodeId) === 1
          );
        });
  return {
    ...document,
    scenes: [
      {
        ...scene,
        tree,
        commands,
        warnings,
        spaces: collectSpaces(tree),
        ...(records === undefined ? {} : { paintRecords: records }),
      },
    ],
    diagnostics,
    target: {
      scope: target.scope,
      id: target.id,
      path: match.path,
      matches: 1,
    },
  };
}
function overBudget(
  bytes: number,
  limit: number,
): InspectionSerializationError {
  return new InspectionSerializationError(
    `Inspection output is ${bytes} bytes of UTF-8, over the ${limit}-byte (${(limit / 2 ** 20).toFixed(2)} MiB) limit. Narrow the output with --target SCOPE#ID and retry.`,
  );
}
/**
 * Iteratively walk an arbitrary inspection document for exact UTF-8 size measurement
 * and serialization without call-stack recursion limits. Retains JSON.stringify for
 * scalar escaping only.
 */
function measureAndSerializeInspection(
  document: InspectionDocument,
  limit: number,
  serialize: boolean,
): { bytes: number; json?: string } {
  let bytes = 0;
  const chunks: string[] = serialize ? [] : [];

  const addAscii = (text: string) => {
    bytes += text.length;
    if (bytes > limit) throw overBudget(bytes, limit);
    if (serialize) chunks.push(text);
  };

  const addScalarString = (text: string) => {
    // Quick lower-bound check: escaped UTF-8 length is at least text.length + 2.
    // If text.length + 2 exceeds limit, fail immediately without allocating JSON.stringify(text).
    if (bytes + text.length + 2 > limit) {
      throw overBudget(bytes + text.length + 2, limit);
    }
    const escaped = JSON.stringify(text);
    let utf8Length = 0;
    for (let i = 0; i < escaped.length; i++) {
      const code = escaped.charCodeAt(i);
      if (code < 0x80) utf8Length += 1;
      else if (code < 0x800) utf8Length += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        utf8Length += 4;
        i++;
      } else {
        utf8Length += 3;
      }
    }
    bytes += utf8Length;
    if (bytes > limit) throw overBudget(bytes, limit);
    if (serialize) chunks.push(escaped);
  };

  type TraversalFrame =
    | { kind: "arr"; obj: object; items: readonly unknown[]; index: number }
    | {
        kind: "obj";
        obj: object;
        keys: string[];
        values: unknown[];
        index: number;
      };

  const stack: TraversalFrame[] = [];
  const activeAncestors = new Set<object>();

  function processValue(value: unknown): void {
    if (value === null) {
      addAscii("null");
      return;
    }
    switch (typeof value) {
      case "boolean":
        addAscii(value ? "true" : "false");
        return;
      case "number":
        addAscii(Number.isFinite(value) ? String(value) : "null");
        return;
      case "string":
        addScalarString(value);
        return;
      case "object": {
        if (activeAncestors.has(value)) {
          throw new InspectionSerializationError(
            "Inspection document contains a cycle.",
          );
        }
        activeAncestors.add(value);

        if (Array.isArray(value)) {
          addAscii("[");
          stack.push({ kind: "arr", obj: value, items: value, index: 0 });
          return;
        }

        addAscii("{");
        const keys: string[] = [];
        const values: unknown[] = [];
        for (const [k, v] of Object.entries(value)) {
          if (v !== undefined) {
            keys.push(k);
            values.push(v);
          }
        }
        stack.push({ kind: "obj", obj: value, keys, values, index: 0 });
        return;
      }
      default:
        addAscii("null");
        return;
    }
  }

  processValue(document);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];

    if (top.kind === "arr") {
      if (top.index < top.items.length) {
        if (top.index > 0) addAscii(",");
        const item = top.items[top.index++];
        processValue(item);
      } else {
        stack.pop();
        activeAncestors.delete(top.obj);
        addAscii("]");
      }
    } else {
      if (top.index < top.keys.length) {
        if (top.index > 0) addAscii(",");
        const key = top.keys[top.index];
        const val = top.values[top.index++];
        addScalarString(key);
        addAscii(":");
        processValue(val);
      } else {
        stack.pop();
        activeAncestors.delete(top.obj);
        addAscii("}");
      }
    }
  }

  return { bytes, json: serialize ? chunks.join("") : undefined };
}

/**
 * Measure the document's UTF-8 size without materializing the whole JSON string.
 *
 * A hostile or simply huge frame must not be allowed to allocate its full encoding
 * before the budget is checked, so the walk stops as soon as the running count
 * passes `limit`. The count is exact only below the limit; above it the function
 * throws. Escaping matches `JSON.stringify` for the characters JSON escapes.
 */
export function measureInspection(
  document: InspectionDocument,
  limit = MAX_INSPECTION_BYTES,
): number {
  return measureAndSerializeInspection(document, limit, false).bytes;
}

/**
 * Serialize the document iteratively, refusing output over `limit` UTF-8 bytes. The size is
 * measured first, so an oversized frame fails before the full JSON string is emitted.
 */
export function serializeInspection(
  document: InspectionDocument,
  limit = MAX_INSPECTION_BYTES,
): string {
  const { bytes, json } = measureAndSerializeInspection(document, limit, true);
  if (new TextEncoder().encode(json!).length !== bytes)
    throw new InspectionSerializationError(
      `Inspection output size could not be verified (${bytes} measured, encoding differs). This is a serializer defect, not a project problem.`,
    );
  return json!;
}
