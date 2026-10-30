import { evaluatePath, pathData, type PathOutline } from "./path";
import { resolveNumber } from "./motion";
import { shapeGeometry } from "./shapes";
import type { MediaSpec } from "./media";
import { evaluateCamera, type CameraState } from "./camera";
import type { StageContext } from "./stage";
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
export type DrawCommand = {
  readonly path: string;
  readonly sharedId?: string;
  readonly bounds: Bounds;
  readonly transform: Transform;
  readonly opacity: number;
} & (
  | {
      readonly kind: "composition";
      readonly frame: EvaluatedFrame;
      readonly overlay?: EvaluatedFrame;
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
    }
);
export interface LayoutNode {
  readonly path: string;
  readonly kind: string;
  readonly bounds: Bounds;
  readonly transform: Transform;
  readonly children: readonly LayoutNode[];
}
export interface EvaluatedFrame {
  /** Optional world → viewport camera; layout bounds remain in world space. */
  readonly camera?: CameraState;
  readonly tree: LayoutNode;
  readonly commands: readonly DrawCommand[];
  readonly warnings: readonly string[];
}
export type MeasureText = (
  text: string,
  font: string,
  tracking: number,
) => number;
interface Measured {
  node: ViewNode;
  path: string;
  width: number;
  height: number;
  children: Measured[];
  text?: TextRun;
  composition?: EvaluatedFrame;
  overlay?: EvaluatedFrame;
  shape?: ReturnType<typeof shapeGeometry>;
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw Error(`${name} must be finite and non-negative.`);
  return value;
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
  },
): EvaluatedFrame {
  const { time, measureText } = options;
  const depth = options.depth ?? 0;
  if (depth > 32) throw Error("Composition nesting exceeds 32 levels.");
  if (!Number.isFinite(time)) throw Error("Time must be finite.");
  const width = positive(options.width, "Stage width"),
    height = positive(options.height, "Stage height");
  const theme = options.theme ?? defaultTheme;
  const warnings: string[] = [];
  const commands: DrawCommand[] = [];
  function measure(
    node: ViewNode,
    w: number,
    h: number,
    path: string,
    axis?: boolean,
  ): Measured {
    try {
      const s = node.spec;
      const m: Measured = { node, path, width: 0, height: 0, children: [] };
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
        const frame = evaluateView(s.world.view(worldEnv), {
          time: worldTime,
          width: s.world.size[0],
          height: s.world.size[1],
          theme: env.theme,
          measureText,
          context: worldEnv,
          depth: depth + 1,
        });
        m.composition = {
          ...frame,
          camera: evaluateCamera(
            typeof settings.camera === "function"
              ? settings.camera(env)
              : (settings.camera ?? {}),
            time,
            viewport,
          ),
        };
        if (settings.overlay)
          m.overlay = evaluateView(settings.overlay(env), {
            time,
            width: viewport[0],
            height: viewport[1],
            theme: env.theme,
            measureText,
            context: env,
            depth: depth + 1,
          });
        m.width = viewport[0];
        m.height = viewport[1];
        warnings.push(
          ...frame.warnings.map((w) => `${path}/world/${w}`),
          ...(m.overlay?.warnings.map((w) => `${path}/overlay/${w}`) ?? []),
        );
      } else if (s.kind === "circle" || s.kind === "line") {
        const geometry = shapeGeometry(s, time);
        m.shape = geometry;
        m.width = geometry.width;
        m.height = geometry.height;
      } else if (s.kind === "image" || s.kind === "video") {
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
          positive(s.x, "Padding");
          positive(s.y, "Padding");
          cw = Math.max(0, w - s.x * 2);
          ch = Math.max(0, h - s.y * 2);
        } else if (s.kind === "frame") {
          cw =
            s.width === undefined || s.width === "fill"
              ? w
              : positive(s.width, "Frame width");
          ch =
            s.height === undefined || s.height === "fill"
              ? h
              : positive(s.height, "Frame height");
        }
        const child = measure(
          s.child,
          cw,
          ch,
          `${path}/${s.child.key ?? s.child.spec.kind}`,
          axis,
        );
        m.children = [child];
        m.width = child.width;
        m.height = child.height;
        if (s.kind === "padding") {
          m.width += s.x * 2;
          m.height += s.y * 2;
        }
        if (s.kind === "frame") {
          if (s.width !== undefined) m.width = cw;
          if (s.height !== undefined) m.height = ch;
        }
      } else {
        const gap = positive(s.options.gap ?? 0, "Stack gap");
        const horizontal = s.kind === "hstack",
          overlay = s.kind === "zstack" || s.kind === "group";
        const main = horizontal ? w : h;
        const available = Math.max(
          0,
          main - (overlay ? 0 : gap * Math.max(0, s.children.length - 1)),
        );
        let remaining = available;
        const flexible = (node: ViewNode): boolean => {
          const spec = node.spec;
          if (spec.kind === "spacer") return true;
          if (spec.kind === "frame") {
            const dimension = horizontal ? spec.width : spec.height;
            if (dimension !== undefined) return dimension === "fill";
          }
          return "child" in spec && flexible(spec.child);
        };
        const keys = new Set<string>();
        const results: (Measured | undefined)[] = s.children.map((child, i) => {
          const key = child.key ?? `${child.spec.kind}[${i}]`;
          if (keys.has(key)) throw Error(`Duplicate sibling ID: ${key}`);
          keys.add(key);
          if (!overlay && flexible(child)) return undefined;
          const measured = measure(
            child,
            horizontal && !overlay ? available : w,
            !horizontal && !overlay ? available : h,
            `${path}/${key}`,
            overlay ? undefined : horizontal,
          );
          if (!overlay)
            remaining = Math.max(
              0,
              remaining - (horizontal ? measured.width : measured.height),
            );
          return measured;
        });
        const flexibleCount = results.filter((r) => !r).length;
        m.children = results.map((result, i) => {
          if (result) return result;
          const child = s.children[i],
            spacer = child.spec.kind === "spacer";
          return measure(
            child,
            horizontal ? remaining / flexibleCount : spacer ? 0 : w,
            horizontal ? (spacer ? 0 : h) : remaining / flexibleCount,
            `${path}/${child.key ?? `${child.spec.kind}[${i}]`}`,
            horizontal,
          );
        });
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
      if (m.width > w + 0.01 || m.height > h + 0.01)
        warnings.push(
          `${path}: content exceeds offered bounds at localTime=${time}`,
        );
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
    if (m.composition)
      commands.push({
        kind: "composition",
        sharedId: m.node.key,
        path: m.path,
        bounds,
        transform: current,
        opacity,
        frame: m.composition,
        overlay: m.overlay,
      });
    if (
      s.kind === "image" ||
      (s.kind === "video" &&
        (options.context?.time ?? time) >= s.clip.start &&
        (options.context?.time ?? time) <= s.clip.start + s.clip.duration)
    )
      commands.push({
        kind: "media",
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
          ? (s.style.fill ??
            (s.style.stroke
              ? undefined
              : (theme.colors.accent ?? theme.textColor)))
          : (s.style.color ?? theme.textColor);
      for (const [outline, color] of [
        [geometry.fill, fill],
        [geometry.stroke, s.kind === "circle" ? s.style.stroke : undefined],
      ] as const)
        if (outline.length && color) {
          commands.push({
            kind: "path",
            sharedId: m.node.key,
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
      commands.push({
        kind: "path",
        path: m.path,
        sharedId: m.node.key,
        bounds,
        transform: current,
        opacity,
        data: pathData(evaluatePath(s, time)),
        outline: evaluatePath(s, time),
        fill: s.style.fill ?? theme.textColor,
        fillRule: s.style.fillRule ?? "nonzero",
      });
    if (s.kind === "box")
      commands.push({
        kind: "box",
        sharedId: m.node.key,
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
      commands.push({
        kind: "text",
        sharedId: m.node.key,
        path: m.path,
        bounds,
        transform: current,
        opacity,
        text: m.text,
      });
    let cursor = 0;
    const children = m.children.map((child) => {
      let cx = x,
        cy = y;
      if (s.kind === "padding") {
        cx += s.x;
        cy += s.y;
      }
      if (s.kind === "frame") {
        cx += align(s.align, m.width - child.width);
        cy += align(s.align, m.height - child.height);
      }
      if (s.kind === "hstack") {
        cx += cursor;
        cy += align(s.options.align ?? "center", m.height - child.height);
        cursor += child.width + (s.options.gap ?? 0);
      }
      if (s.kind === "vstack") {
        cy += cursor;
        cx += align(s.options.align ?? "center", m.width - child.width);
        cursor += child.height + (s.options.gap ?? 0);
      }
      if (s.kind === "zstack" || s.kind === "group") {
        cx += align(s.options.align ?? "center", m.width - child.width);
        cy += align(s.options.align ?? "center", m.height - child.height);
      }
      return place(child, cx, cy, current, opacity);
    });
    if (m.composition) children.push(m.composition.tree);
    if (m.overlay) children.push(m.overlay.tree);
    return { path: m.path, kind: s.kind, bounds, transform: current, children };
  }
  const measured = measure(root, width, height, root.key ?? "root");
  return { tree: place(measured, 0, 0, [1, 1, 0, 0], 1), commands, warnings };
}
