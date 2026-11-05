import { snapshotNumber, type AnimatedNumber } from "./motion";
import type { PathSpec } from "./path";
import { snapshotClip, type ClipShape } from "./clip";
import type { CompositionSpec } from "./composition";
import type { ShapeSpec } from "./shapes";
import type { MediaSpec } from "./media";

export type Alignment = "start" | "center" | "end";
export type Dimension = number | "fill";
/** Per-edge insets; an omitted edge is zero. */
export interface PaddingInsets {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}
export interface FrameOptions {
  readonly width?: Dimension;
  readonly height?: Dimension;
  /** Both axes; `alignX`/`alignY` override it per axis. Defaults to center. */
  readonly align?: Alignment;
  readonly alignX?: Alignment;
  readonly alignY?: Alignment;
}
export interface TextStyle {
  readonly font?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly color?: string;
  readonly align?: "left" | "center" | "right";
  readonly tracking?: number;
  readonly lineHeight?: number;
  readonly maxWidth?: number;
  readonly wrap?: boolean;
}
export interface BoxStyle {
  readonly width: AnimatedNumber;
  readonly height: AnimatedNumber;
  readonly fill?: string;
  readonly radius?: number;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}
/** Box paint without a size: a background fills the wrapped node's measured bounds. */
export type BackgroundStyle = Omit<BoxStyle, "width" | "height">;
export interface StackOptions {
  readonly gap?: number;
  readonly align?: Alignment;
}
export type NodeSpec =
  | {
      readonly kind: "clip";
      readonly shape: ClipShape;
      readonly child: ViewNode;
    }
  | PathSpec
  | ShapeSpec
  | MediaSpec
  | CompositionSpec
  | { readonly kind: "text"; readonly text: string; readonly style: TextStyle }
  | { readonly kind: "box"; readonly style: BoxStyle }
  | { readonly kind: "spacer" }
  | {
      readonly kind: "hstack" | "vstack" | "zstack" | "group";
      readonly options: StackOptions;
      readonly children: readonly ViewNode[];
    }
  | {
      readonly kind: "padding";
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      readonly left: number;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "background";
      readonly style: BackgroundStyle;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "frame";
      readonly width?: Dimension;
      readonly height?: Dimension;
      readonly align: Alignment;
      readonly alignX?: Alignment;
      readonly alignY?: Alignment;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "flex";
      readonly weight: number;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "opacity";
      readonly value: AnimatedNumber;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "offset";
      readonly x: AnimatedNumber;
      readonly y: AnimatedNumber;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "scale";
      readonly x: AnimatedNumber;
      readonly y: AnimatedNumber;
      readonly anchor: readonly [number, number];
      readonly child: ViewNode;
    };

function animated(value: AnimatedNumber): AnimatedNumber {
  return snapshotNumber(value);
}
function backgroundStyle(style: BackgroundStyle): BackgroundStyle {
  if (typeof style !== "object" || style === null)
    throw Error("Background needs a style object.");
  if ("width" in style || "height" in style)
    throw Error(
      "Background sets no size; wrap the content in an explicit frame instead.",
    );
  for (const [name, value] of [
    ["radius", style.radius ?? 0],
    ["strokeWidth", style.strokeWidth ?? 0],
  ] as const)
    if (!Number.isFinite(value) || value < 0)
      throw Error(`Background ${name} must be finite and non-negative.`);
  return Object.freeze({
    fill: style.fill,
    radius: style.radius,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  });
}

/** Immutable wrappers preserve modifier order and allow nodes to be reused. */
export class ViewNode {
  constructor(
    readonly spec: NodeSpec,
    readonly key?: string,
  ) {
    Object.freeze(spec);
    Object.freeze(this);
  }
  id(key: string): ViewNode {
    if (!key) throw Error("Node ID must not be empty.");
    return new ViewNode(this.spec, key);
  }
  /** Clip to current layout bounds; frame first to select a fixed viewport. */
  clip(shape: ClipShape = { shape: "rect" }): ViewNode {
    return new ViewNode({
      kind: "clip",
      shape: snapshotClip(shape),
      child: this,
    });
  }
  padding(value: number, y?: number): ViewNode;
  padding(value: PaddingInsets): ViewNode;
  padding(value: number | PaddingInsets, y?: number): ViewNode {
    if (typeof value === "number")
      return new ViewNode({
        kind: "padding",
        top: y ?? value,
        right: value,
        bottom: y ?? value,
        left: value,
        child: this,
      });
    if (typeof value !== "object" || value === null)
      throw Error("Padding needs a number or an inset object.");
    // Silently ignoring an unknown key would drop the inset the author asked for.
    for (const key of Object.keys(value))
      if (!["top", "right", "bottom", "left"].includes(key))
        throw Error(
          `Padding inset "${key}" is not supported; use top, right, bottom, left.`,
        );
    return new ViewNode({
      kind: "padding",
      top: value.top ?? 0,
      right: value.right ?? 0,
      bottom: value.bottom ?? 0,
      left: value.left ?? 0,
      child: this,
    });
  }
  frame(options: FrameOptions): ViewNode {
    return new ViewNode({
      kind: "frame",
      ...options,
      align: options.align ?? "center",
      child: this,
    });
  }
  /**
   * Flexible main-axis slot inside HStack or VStack with proportional weight.
   * Flex participates at the nearest enclosing sequential stack boundary only.
   */
  flex(weight: number = 1): ViewNode {
    if (!Number.isFinite(weight) || weight <= 0)
      throw Error("Flex weight must be finite and positive.");
    return new ViewNode({
      kind: "flex",
      weight,
      child: this,
    });
  }
  /** Paints the child's measured bounds behind it; never changes size or clips. */
  background(style: BackgroundStyle): ViewNode {
    return new ViewNode({
      kind: "background",
      style: backgroundStyle(style),
      child: this,
    });
  }
  opacity(value: AnimatedNumber): ViewNode {
    return new ViewNode({
      kind: "opacity",
      value: animated(value),
      child: this,
    });
  }
  offset(x: AnimatedNumber, y: AnimatedNumber = 0): ViewNode {
    return new ViewNode({
      kind: "offset",
      x: animated(x),
      y: animated(y),
      child: this,
    });
  }
  scale(
    x: AnimatedNumber,
    y: AnimatedNumber = x,
    anchor: readonly [number, number] = [0.5, 0.5],
  ): ViewNode {
    return new ViewNode({
      kind: "scale",
      x: animated(x),
      y: animated(y),
      anchor: Object.freeze([...anchor]) as readonly [number, number],
      child: this,
    });
  }
}
export function Text(text: string, style: TextStyle = {}): ViewNode {
  return new ViewNode({
    kind: "text",
    text,
    style: Object.freeze({ ...style }),
  });
}
export function Box(style: BoxStyle): ViewNode {
  return new ViewNode({
    kind: "box",
    style: Object.freeze({
      ...style,
      width: animated(style.width),
      height: animated(style.height),
    }),
  });
}
export function Spacer(): ViewNode {
  return new ViewNode({ kind: "spacer" });
}
function stack(
  kind: "hstack" | "vstack" | "zstack" | "group",
  children: readonly ViewNode[],
  options: StackOptions,
): ViewNode {
  return new ViewNode({
    kind,
    children: Object.freeze([...children]),
    options: Object.freeze({ ...options }),
  });
}
export function HStack(
  children: readonly ViewNode[],
  options: StackOptions = {},
): ViewNode {
  return stack("hstack", children, options);
}
export function VStack(
  children: readonly ViewNode[],
  options: StackOptions = {},
): ViewNode {
  return stack("vstack", children, options);
}
/** One layout slot; children are composited together before applying group opacity. */
export function Group(children: readonly ViewNode[]): ViewNode {
  return stack("group", children, { align: "start" });
}
/** Expand into a parent Stack, preserving semantic IDs through modifier wrappers. */
export function ForEach<T>(
  items: readonly T[],
  key: (item: T, index: number) => string,
  view: (item: T, index: number) => ViewNode,
): readonly ViewNode[] {
  const keys = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const id = key(item, index);
      if (typeof id !== "string" || !id || keys.has(id))
        throw Error(`ForEach needs unique non-empty IDs: ${id}`);
      keys.add(id);
      return view(item, index).id(id);
    }),
  );
}
export function ZStack(
  children: readonly ViewNode[],
  options: StackOptions = {},
): ViewNode {
  return stack("zstack", children, options);
}
