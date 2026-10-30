import { snapshotNumber, type AnimatedNumber } from "./motion";
import type { PathSpec } from "./path";
import type { CompositionSpec } from "./composition";
import type { ShapeSpec } from "./shapes";
import type { MediaSpec } from "./media";

export type Alignment = "start" | "center" | "end";
export type Dimension = number | "fill";
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
export interface StackOptions {
  readonly gap?: number;
  readonly align?: Alignment;
}
export type NodeSpec =
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
      readonly x: number;
      readonly y: number;
      readonly child: ViewNode;
    }
  | {
      readonly kind: "frame";
      readonly width?: Dimension;
      readonly height?: Dimension;
      readonly align: Alignment;
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
  padding(x: number, y = x): ViewNode {
    return new ViewNode({ kind: "padding", x, y, child: this });
  }
  frame(options: {
    width?: Dimension;
    height?: Dimension;
    align?: Alignment;
  }): ViewNode {
    return new ViewNode({
      kind: "frame",
      ...options,
      align: options.align ?? "center",
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
/** One layout slot, top-left overlay children; opacity remains per primitive. */
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
