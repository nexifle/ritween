import { flattenPath } from "./path-geometry";
import type { ImageTexture } from "../engine/render/visual";
import { fitMedia } from "./media";
import { mediaKey } from "./media-runtime";
import type { RenderContext, SetupContext } from "../engine/types";
import { identity, inverse, multiply } from "../engine/render/shared-elements";
import type {
  Bounds,
  DrawCommand,
  EvaluatedFrame,
  InspectionIdentity,
  TextRun,
} from "./layout";
import { computeFrameTransform } from "./frame-transform";
import { projectRect } from "./project-rect";
import { planSurface } from "./surface-plan";
import { checkVertexFloat32 } from "./vertex-float32";
import {
  baseFrameMapping,
  childPixelsToParent,
  copySurfaceUniform,
  EMPTY_FRAME_OCCURRENCES,
  EMPTY_SURFACE_TRACES,
  MISSING_LAYOUT_SPACE_REASON,
  NON_CLIP_PARENT_REASON,
  projectRectClipChain,
  ROOT_TARGET_REASON,
  SurfaceProjectionTraces,
  uploadedCameraMapping,
  type CapturedPaint,
  type CopiedSurfaceUniform,
  type ClipSurfaceShape,
  type FrameOccurrence,
  type InspectionSurface,
  type PixelRect,
  type SurfaceLevel,
  type SurfaceTrace,
  type SurfaceTracePass,
  type TargetWindow,
} from "./surface-projection";

const shader = `
struct Controls {
  rect: vec4f, transform: vec4f, resolution: vec2f, radius: f32, strokeWidth: f32,
  fill: vec4f, stroke: vec4f, opacity: f32, textured: f32, padding: vec2f,
  cameraX: vec4f, cameraY: vec4f, uvRect: vec4f
};
@group(0) @binding(0) var<uniform> c: Controls;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage,read> edges: array<vec4f>;
@group(0) @binding(4) var maskImage: texture_2d<f32>;
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let uv=corners[i]; let world=(c.rect.xy+uv*c.rect.zw)*c.transform.xy+c.transform.zw;
  let p=vec2f(dot(c.cameraX.xyz,vec3f(world,1)),dot(c.cameraY.xyz,vec3f(world,1)));
  var o:Out; o.pos=vec4f(p.x/c.resolution.x*2-1,1-p.y/c.resolution.y*2,0,1); o.uv=uv; return o;
}
@fragment fn fs(i:Out) -> @location(0) vec4f {
  if(c.textured>4.5) {
    let sample=textureSample(image,samp,i.uv);
    let mask=textureSample(maskImage,samp,i.uv);
    let coverage=mask.a*select(1.,dot(mask.rgb,vec3f(0.2126,0.7152,0.0722)),c.textured>5.5);
    return vec4f(sample.rgb/max(sample.a,0.00001),sample.a*c.opacity*coverage);
  }
  if(c.textured>2.5) {
    let p=i.uv*c.rect.zw; var winding=0; var distance=1e20;
    for(var j=0u;j<u32(c.padding.x);j++) {
      let edge=edges[j]; let a=edge.xy; let b=edge.zw; let v=b-a;
      let nearest=a+v*clamp(dot(p-a,v)/max(dot(v,v),1e-20),0.,1.);
      distance=min(distance,length(p-nearest));
      let cross=v.x*(p.y-a.y)-v.y*(p.x-a.x);
      if(a.y<=p.y && b.y>p.y && cross>0.) { winding++; }
      if(a.y>p.y && b.y<=p.y && cross<0.) { winding--; }
    }
    let inside=select(winding!=0,abs(winding)%2==1,c.padding.y>0.5);
    let aa=max(length(fwidth(p)),0.00001);
    let coverage=clamp(0.5+select(-distance,distance,inside)/aa,0.,1.);
    if(c.textured>3.5) {
      let sample=textureSample(image,samp,i.uv);
      return vec4f(sample.rgb/max(sample.a,0.00001),sample.a*c.opacity*coverage);
    }
    return vec4f(c.fill.rgb,c.fill.a*c.opacity*coverage);
  }
  let sample=textureSample(image,samp,i.uv*c.uvRect.xy+c.uvRect.zw);
  if(c.textured>1.5) { return vec4f(sample.rgb/max(sample.a,0.00001),sample.a*c.opacity); }
  if(c.textured>0.5) { return vec4f(sample.rgb,sample.a*c.opacity); }
  let halfSize=c.rect.zw*0.5; let r=min(c.radius,min(halfSize.x,halfSize.y));
  let q=abs((i.uv-0.5)*c.rect.zw)-halfSize+vec2f(r);
  let d=length(max(q,vec2f(0)))+min(max(q.x,q.y),0)-r;
  let aa=max(fwidth(d),0.0001);
  let coverage=1-smoothstep(-aa,0.,d);
  let edge=smoothstep(-c.strokeWidth-aa,-c.strokeWidth+aa,d)*step(0.0001,c.strokeWidth);
  let color=mix(c.fill,c.stroke,edge);
  return vec4f(color.rgb,color.a*coverage*c.opacity);
}`;
interface CachedText {
  texture: GPUTexture;
  bytes: number;
}
// shortcut: cache whole text runs, use a glyph atlas when measured label workloads exceed these budgets.
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_ENTRIES = 128;

/**
 * One paint record for an internal collector. `bounds` is the projected draw quad: the
 * mathematical image of the float32 uniforms the renderer uploaded, computed here in binary64.
 * It is not a pixel bound and not a model of GPU rounding, so it never proves which fragments
 * the shader painted. For Text the quad is the uploaded texture/line box before transition,
 * not glyph ink. For Media it is the fitted texture rectangle already packed into that uniform
 * after contain, cover, or crop; crop UVs, image alpha, and mask coverage are not ink or pixel
 * bounds, and the quad stays `conservative` even when axis-aligned. Radius, stroke, color alpha,
 * antialiasing, scissor, occlusion, and compositing all live inside that quad. Shared-element
 * corrections are already part of the draw camera, so `space` stays the pre-transition scene
 * target, not final transition output.
 * `accuracy` is the discriminant: `unavailable` means no rectangle this collector can honestly
 * record, so coverage stays partial instead of claiming the paint is out of frame. A tagged
 * Clip, Group, or Composition chain projects the outer draw quad of its Box, Text, and Media
 * leaves into this space. Composition is one surface: World then Overlay share its texture and
 * occurrence. Untagged surfaces are not forwarded. That quad is not mask pixels, an outline,
 * occlusion, or fragment coverage. Stage and project overlay stay out of scope. This is not a
 * completed G3 projection.
 */
/** One tagged surface the leaf quad was clipped through, leaf target first. */
export type SurfaceBoundary =
  | { readonly occurrenceId: number; readonly kind: "group" }
  | { readonly occurrenceId: number; readonly kind: "composition" }
  | {
      readonly occurrenceId: number;
      readonly kind: "clip";
      readonly shape: ClipSurfaceShape;
    };
/** Viewport/scissor chain of the outer quad. Not fragment coverage or a mask outline. */
export interface SurfaceProjection {
  readonly boundaries: readonly SurfaceBoundary[];
  /** `outer-clipped-draw-quad` only when a Clip boundary is non-rect. Group and Composition add no shape. */
  readonly coverage: "rect-clipped-draw-quad" | "outer-clipped-draw-quad";
}
export type PaintRecord = {
  readonly path: string;
  /** Present only when the frame was evaluated with inspection enabled. */
  readonly inspection?: InspectionIdentity;
  readonly paintRole: "content" | "background";
  readonly space: "scene-target-pixels";
  readonly resolution: readonly [number, number];
} & (
  | {
      readonly kind: "box";
      /**
       * `exact-rectangle` when the ideal projection keeps the quad axis-aligned; `conservative`
       * carries its AABB. Neither encloses GPU rounding.
       */
      readonly accuracy: "exact-rectangle" | "conservative";
      /** Ideal projected quad AABB in `space`, from the uploaded float32 uniforms. */
      readonly bounds: Bounds;
      readonly provenance: "projected-box-draw-quad";
      /**
       * Positive area of the outer quad and nonzero opacity, including `-0` as hidden. Potential
       * visibility only: an empty mask can still be true, and this is not fragment proof.
       */
      readonly geometryVisible: boolean;
      /** Present only when this draw passed through at least one tagged surface. */
      readonly surfaceProjection?: SurfaceProjection;
      readonly unsupported?: never;
    }
  | {
      readonly kind: "text";
      readonly accuracy: "exact-rectangle" | "conservative";
      /** Ideal projected texture/line-box AABB, not glyph ink or a raster-texture pixel size. */
      readonly bounds: Bounds;
      readonly provenance: "projected-text-draw-quad";
      readonly geometryVisible: boolean;
      readonly surfaceProjection?: SurfaceProjection;
      readonly unsupported?: never;
    }
  | {
      readonly kind: "media";
      /** Always conservative: an axis-aligned texture quad is not proven pixel or ink coverage. */
      readonly accuracy: "conservative";
      /** Ideal projected texture-quad AABB after fitting, not a UV crop or alpha bound. */
      readonly bounds: Bounds;
      readonly provenance:
        "projected-image-draw-quad" | "projected-video-draw-quad";
      readonly geometryVisible: boolean;
      readonly surfaceProjection?: SurfaceProjection;
      readonly unsupported?: never;
    }
  | {
      readonly kind: DrawCommand["kind"];
      readonly accuracy: "unavailable";
      readonly unsupported: string;
      readonly bounds?: never;
    }
);

/**
 * Builds one record from the uniform block this draw uploaded; see {@link PaintRecord}.
 * Field offsets are the `Controls` struct floats the vertex shader reads.
 */
function paintRecord(
  command: DrawCommand,
  uniforms: Float32Array,
  offset: number,
): PaintRecord {
  const at = (index: number) => uniforms[offset + index];
  // A fresh resolution tuple keeps the record independent of the caller's array.
  const resolution: readonly [number, number] = [at(8), at(9)];
  const identity = {
    kind: command.kind,
    path: command.path,
    ...(command.inspection ? { inspection: { ...command.inspection } } : {}),
    paintRole: command.paintRole ?? "content",
    space: "scene-target-pixels",
    resolution,
  } as const;
  const unsupported = (reason: string): PaintRecord => ({
    ...identity,
    accuracy: "unavailable",
    unsupported: reason,
  });
  if (
    command.kind !== "box" &&
    command.kind !== "text" &&
    command.kind !== "media"
  )
    return unsupported(
      `${command.kind} paint is not collected; only top-level Box, Text, and Media draw quads are.`,
    );
  // Only the fields quad projection and `geometryVisible` read: radius, stroke, colors, UV,
  // padding, and texture flags never change either.
  const fields: readonly (readonly [string, number])[] = [
    ["rect x", at(0)],
    ["rect y", at(1)],
    ["rect width", at(2)],
    ["rect height", at(3)],
    ["transform scale x", at(4)],
    ["transform scale y", at(5)],
    ["transform translate x", at(6)],
    ["transform translate y", at(7)],
    ["resolution x", at(8)],
    ["resolution y", at(9)],
    ["opacity", at(20)],
    ["camera X x", at(24)],
    ["camera X y", at(25)],
    ["camera X constant", at(26)],
    ["camera Y x", at(28)],
    ["camera Y y", at(29)],
    ["camera Y constant", at(30)],
  ];
  const notFinite = fields
    .filter(([, value]) => !Number.isFinite(value))
    .map(([name]) => name);
  if (notFinite.length)
    return unsupported(`draw quad is not finite: ${notFinite.join(", ")}.`);
  if (resolution[0] <= 0 || resolution[1] <= 0)
    return unsupported(
      `draw quad is not finite: resolution ${resolution[0]}x${resolution[1]} is not positive.`,
    );
  const rect = [at(0), at(1), at(2), at(3)] as const;
  const transform = [at(4), at(5), at(6), at(7)] as const;
  const cameraX = [at(24), at(25), at(26)] as const;
  const cameraY = [at(28), at(29), at(30)] as const;
  try {
    checkVertexFloat32(rect, transform, cameraX, cameraY);
  } catch (error) {
    // Finite uniforms can still overflow a float32 vertex stage, so the collector conservatively
    // marks the quad unavailable; that says nothing about GPU clipping or visibility.
    return unsupported(
      `draw quad overflows float32 vertex stages: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Camera rows then the command transform, as the vertex shader composes them.
  const [a, b, c, d, e, f] = multiply(
    [cameraX[0], cameraY[0], cameraX[1], cameraY[1], cameraX[2], cameraY[2]],
    [transform[0], 0, 0, transform[1], transform[2], transform[3]],
  );
  let projected: ReturnType<typeof projectRect>;
  try {
    projected = projectRect(
      { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
      [a, b, c, d, e, f],
      at(20),
    );
  } catch (error) {
    return unsupported(
      `draw quad is not finite: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Media stays conservative even when the texture quad is axis-aligned: the rectangle is the
  // ideal fitted uniform, not alpha, ink, or fragment coverage.
  const accuracy: "exact-rectangle" | "conservative" =
    command.kind === "media" || projected.accuracy !== "exact"
      ? "conservative"
      : "exact-rectangle";
  const paintRole: "content" | "background" = command.paintRole ?? "content";
  const shared = {
    path: command.path,
    ...(command.inspection ? { inspection: { ...command.inspection } } : {}),
    paintRole,
    space: "scene-target-pixels" as const,
    resolution,
    accuracy,
    bounds: projected.bounds,
    geometryVisible: projected.visible,
  };
  // Provenance names which draw this uniform block was. Text uses the same uploaded `b`
  // as the texture quad (line box), not measured glyph advances. Media provenance comes from
  // the typed command source, not from path text or a second fit.
  if (command.kind === "text")
    return {
      ...shared,
      kind: "text" as const,
      provenance: "projected-text-draw-quad" as const,
    };
  if (command.kind === "media")
    return {
      ...shared,
      kind: "media" as const,
      accuracy: "conservative",
      provenance:
        command.source.kind === "video"
          ? "projected-video-draw-quad"
          : "projected-image-draw-quad",
    };
  return {
    ...shared,
    kind: "box" as const,
    provenance: "projected-box-draw-quad" as const,
  };
}

function copiedIdentity(command: DrawCommand): {
  readonly path: string;
  readonly inspection?: InspectionIdentity;
  readonly paintRole: "content" | "background";
} {
  return {
    path: command.path,
    ...(command.inspection
      ? {
          inspection: {
            id: command.inspection.id,
            nodeId: command.inspection.nodeId,
            role: command.inspection.role,
          },
        }
      : {}),
    paintRole: command.paintRole ?? "content",
  };
}

/** Four boundary corners of the uploaded quad, in that draw's target pixels. Not an AABB. */
function captureLeaf(
  command: DrawCommand,
  uniforms: Float32Array,
  offset: number,
): CapturedPaint {
  const at = (index: number) => uniforms[offset + index];
  const identity = copiedIdentity(command);
  const provenance =
    command.kind === "text"
      ? ("projected-text-draw-quad" as const)
      : command.kind === "media"
        ? command.source.kind === "video"
          ? ("projected-video-draw-quad" as const)
          : ("projected-image-draw-quad" as const)
        : ("projected-box-draw-quad" as const);
  const commandKind =
    command.kind === "text" || command.kind === "media" ? command.kind : "box";
  const failed = (failure: string): CapturedPaint => ({
    kind: "leaf",
    commandKind,
    ...identity,
    provenance,
    opacity: at(20),
    failure,
  });
  const fields: readonly (readonly [string, number])[] = [
    ["rect x", at(0)],
    ["rect y", at(1)],
    ["rect width", at(2)],
    ["rect height", at(3)],
    ["transform scale x", at(4)],
    ["transform scale y", at(5)],
    ["transform translate x", at(6)],
    ["transform translate y", at(7)],
    ["resolution x", at(8)],
    ["resolution y", at(9)],
    ["opacity", at(20)],
    ["camera X x", at(24)],
    ["camera X y", at(25)],
    ["camera X constant", at(26)],
    ["camera Y x", at(28)],
    ["camera Y y", at(29)],
    ["camera Y constant", at(30)],
  ];
  const notFinite = fields
    .filter(([, value]) => !Number.isFinite(value))
    .map(([name]) => name);
  if (notFinite.length)
    return failed(`draw quad is not finite: ${notFinite.join(", ")}.`);
  if (at(8) <= 0 || at(9) <= 0)
    return failed(
      `draw quad is not finite: resolution ${at(8)}x${at(9)} is not positive.`,
    );
  const rect = [at(0), at(1), at(2), at(3)] as const;
  const transform = [at(4), at(5), at(6), at(7)] as const;
  const cameraX = [at(24), at(25), at(26)] as const;
  const cameraY = [at(28), at(29), at(30)] as const;
  try {
    checkVertexFloat32(rect, transform, cameraX, cameraY);
  } catch (error) {
    return failed(
      `draw quad overflows float32 vertex stages: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [x, y, width, height] = rect;
  const [sx, sy, tx, ty] = transform;
  const uvs = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
  const corners = uvs.map(([u, v]) => {
    const worldX = (x + u * width) * sx + tx;
    const worldY = (y + v * height) * sy + ty;
    return [
      cameraX[0] * worldX + cameraX[1] * worldY + cameraX[2],
      cameraY[0] * worldX + cameraY[1] * worldY + cameraY[2],
    ] as const;
  }) as unknown as readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  if (corners.some((point) => !point.every(Number.isFinite)))
    return failed("draw quad is not finite: projected corner.");
  return {
    kind: "leaf",
    commandKind,
    ...identity,
    provenance,
    opacity: at(20),
    corners,
  };
}

function captureBoundary(command: DrawCommand): CapturedPaint {
  return {
    kind: "boundary",
    commandKind: command.kind,
    ...copiedIdentity(command),
    unsupported: `${command.kind} paint is not collected; only top-level Box, Text, and Media draw quads are.`,
  };
}

type PublishSlot =
  | { readonly kind: "record"; readonly record: PaintRecord }
  | { readonly kind: "surface"; readonly occurrenceId: number };

function unavailableRecord(
  identity: {
    readonly kind: string;
    readonly path: string;
    readonly inspection?: InspectionIdentity;
    readonly paintRole: "content" | "background";
  },
  resolution: readonly [number, number],
  unsupported: string,
): PaintRecord {
  return {
    kind: identity.kind as DrawCommand["kind"],
    path: identity.path,
    ...(identity.inspection ? { inspection: identity.inspection } : {}),
    paintRole: identity.paintRole,
    space: "scene-target-pixels",
    resolution,
    accuracy: "unavailable",
    unsupported,
  };
}

function levelWindow(
  resolution: readonly [number, number],
  scissor: PixelRect | undefined,
): TargetWindow | undefined {
  if (!scissor) return undefined;
  if (!(resolution[0] > 0) || !(resolution[1] > 0)) return undefined;
  return { resolution: [resolution[0], resolution[1]], scissor };
}

interface SurfaceNode {
  readonly occurrenceId: number;
  readonly surface: SurfaceTrace["surface"];
  readonly childResolution: readonly [number, number];
  readonly uniform: CopiedSurfaceUniform;
  readonly paints: CapturedPaint[];
  readonly nested: readonly SurfaceNode[];
  readonly childScissor?: PixelRect;
}

function projectNode(
  surface: SurfaceNode,
  suffix: readonly SurfaceLevel[],
  inherited: string | undefined,
  root: TargetWindow,
  rootResolution: readonly [number, number],
  out: PaintRecord[],
) {
  const child = levelWindow(surface.childResolution, surface.childScissor);
  const mapped = child
    ? importChildMatrix(surface)
    : {
        status: "unavailable" as const,
        reason: "surface child scissor was not recorded.",
      };
  const blocked =
    inherited ??
    (mapped.status === "unavailable" ? mapped.reason : undefined);
  const level: SurfaceLevel | undefined =
    child && mapped.status === "mapped"
      ? {
          occurrenceId: surface.occurrenceId,
          surface: surface.surface,
          opacity: surface.uniform.opacity,
          matrix: mapped.matrix,
          child,
        }
      : undefined;
  const chain = level ? [level, ...suffix] : suffix;
  for (const paint of surface.paints) {
    if (paint.kind === "nested") {
      const childSurface = surface.nested.find(
        (entry) => entry.occurrenceId === paint.occurrenceId,
      );
      if (childSurface)
        projectNode(childSurface, chain, blocked, root, rootResolution, out);
      continue;
    }
    if (paint.kind === "boundary") {
      out.push(
        unavailableRecord(
          {
            kind: paint.commandKind,
            path: paint.path,
            ...(paint.inspection ? { inspection: paint.inspection } : {}),
            paintRole: paint.paintRole,
          },
          rootResolution,
          paint.unsupported,
        ),
      );
      continue;
    }
    if (paint.failure || blocked || !paint.corners || !level) {
      out.push(
        unavailableRecord(
          {
            kind: paint.commandKind,
            path: paint.path,
            ...(paint.inspection ? { inspection: paint.inspection } : {}),
            paintRole: paint.paintRole,
          },
          rootResolution,
          paint.failure ??
            blocked ??
            "surface child scissor was not recorded.",
        ),
      );
      continue;
    }
    const projected = projectRectClipChain(
      paint.corners,
      paint.opacity,
      chain,
      root,
    );
    if (projected.status === "unavailable") {
      out.push(
        unavailableRecord(
          {
            kind: paint.commandKind,
            path: paint.path,
            ...(paint.inspection ? { inspection: paint.inspection } : {}),
            paintRole: paint.paintRole,
          },
          rootResolution,
          projected.reason,
        ),
      );
      continue;
    }
    const boundaries = chain.map((entry): SurfaceBoundary => {
      const surface = entry.surface;
      if (surface.kind === "group" || surface.kind === "composition")
        return { occurrenceId: entry.occurrenceId, kind: surface.kind };
      return {
        occurrenceId: entry.occurrenceId,
        kind: "clip",
        shape: surface.shape,
      };
    });
    const nonRect = boundaries.some(
      (boundary) => boundary.kind === "clip" && boundary.shape !== "rect",
    );
    // Any non-rect Clip is conservative even when the outer quad is axis-aligned or empty.
    const accuracy =
      paint.commandKind === "media" || nonRect || !projected.axisAligned
        ? "conservative"
        : "exact-rectangle";
    const surfaceProjection: SurfaceProjection = {
      boundaries,
      coverage: nonRect
        ? "outer-clipped-draw-quad"
        : "rect-clipped-draw-quad",
    };
    const shared = {
      path: paint.path,
      ...(paint.inspection ? { inspection: paint.inspection } : {}),
      paintRole: paint.paintRole,
      space: "scene-target-pixels" as const,
      resolution: rootResolution,
      bounds: projected.bounds,
      geometryVisible: projected.geometryVisible,
      surfaceProjection,
    };
    if (paint.commandKind === "text")
      out.push({
        ...shared,
        kind: "text",
        accuracy,
        provenance: "projected-text-draw-quad",
      });
    else if (paint.commandKind === "media")
      out.push({
        ...shared,
        kind: "media",
        accuracy: "conservative",
        provenance: paint.provenance as
          | "projected-image-draw-quad"
          | "projected-video-draw-quad",
      });
    else
      out.push({
        ...shared,
        kind: "box",
        accuracy,
        provenance: "projected-box-draw-quad",
      });
  }
}

function importChildMatrix(surface: SurfaceNode) {
  return childPixelsToParent(
    surface.uniform,
    surface.childResolution[0],
    surface.childResolution[1],
  );
}

function isTaggedSurface(
  command: DrawCommand,
): command is Extract<DrawCommand, { kind: "composition" | "group" }> & {
  readonly inspection: InspectionIdentity;
  readonly inspectionSurface: InspectionSurface;
} {
  return (
    (command.kind === "composition" || command.kind === "group") &&
    command.inspectionSurface !== undefined &&
    command.inspection !== undefined
  );
}

/** WebGPU owns paint/compositing; Canvas 2D is only the text rasterizer. */
export class ViewRenderer {
  private pipeline?: GPURenderPipeline;
  private uniform?: GPUBuffer;
  private edgeBuffer?: GPUBuffer;
  private white?: GPUTexture;
  private sampler?: GPUSampler;
  private texts = new Map<string, CachedText>();
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d")!;
  private disposed = false;
  private colors = new Map<string, readonly number[]>();
  /** Set by the parent render only for the child call, then cleared. */
  private tracePass?: SurfaceTracePass;
  private surfaceProjection: readonly SurfaceTrace[] = EMPTY_SURFACE_TRACES;
  private frameOccurrenceSnapshot: readonly FrameOccurrence[] =
    EMPTY_FRAME_OCCURRENCES;
  private ownsShared = true;
  private surfaces = new Map<
    string,
    {
      texture: GPUTexture;
      world: ViewRenderer;
      overlay?: ViewRenderer;
      width: number;
      height: number;
    }
  >();
  private budget = { bytes: 0, textBytes: 0, textEntries: 0 };
  private fork(): ViewRenderer {
    const child = new ViewRenderer();
    child.pipeline = this.pipeline;
    child.white = this.white;
    child.sampler = this.sampler;
    child.ownsShared = false;
    child.budget = this.budget;
    return child;
  }
  async setup(context: SetupContext) {
    if (!this.context) throw Error("Text requires a Canvas 2D context.");
    const module = context.device.createShaderModule({
      label: "View primitives",
      code: shader,
    });
    const pipeline = await context.device.createRenderPipelineAsync({
      label: "View primitives",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: context.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    if (this.disposed) throw Error("View renderer was disposed during setup.");
    this.pipeline = pipeline;
    this.white = context.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    context.device.queue.writeTexture(
      { texture: this.white },
      new Uint8Array([255, 255, 255, 255]),
      {},
      [1, 1],
    );
    this.sampler = context.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
  }
  measureText = (text: string, font: string, tracking: number): number => {
    const p = this.context;
    p.font = font;
    p.letterSpacing = `${tracking}px`;
    return p.measureText(text).width;
  };
  private color(value: string): readonly number[] {
    const cached = this.colors.get(value);
    if (cached) return cached;
    if (
      !CSS.supports("color", value) ||
      /currentcolor|var\(|inherit/i.test(value)
    )
      throw Error(`Expected an explicit color: ${value}`);
    const p = this.context;
    p.resetTransform();
    p.clearRect(0, 0, 1, 1);
    p.fillStyle = value;
    p.fillRect(0, 0, 1, 1);
    const color = Array.from(p.getImageData(0, 0, 1, 1).data, (v) => v / 255);
    if (this.colors.size >= 256) this.colors.clear();
    this.colors.set(value, color);
    return color;
  }
  private textKey(
    text: TextRun,
    width: number,
    height: number,
    scale: number,
  ): string {
    return JSON.stringify([text, width, height, scale]);
  }
  private rasterText(
    command: Extract<DrawCommand, { kind: "text" }>,
    scale: number,
    context: RenderContext,
  ): CachedText {
    const b = command.bounds;
    const width = Math.max(1, Math.ceil(b.width * scale)),
      height = Math.max(1, Math.ceil(b.height * scale));
    const bytes = width * height * 4;
    if (
      width > context.device.limits.maxTextureDimension2D ||
      height > context.device.limits.maxTextureDimension2D ||
      bytes > MAX_TEXT_BYTES
    )
      throw Error(
        `${command.path}: text texture exceeds device or 64 MiB cache limit.`,
      );
    if (
      this.budget.textBytes + bytes > MAX_TEXT_BYTES ||
      this.budget.textEntries >= MAX_TEXT_ENTRIES
    )
      throw Error(
        `${command.path}: active text exceeds bounded cache capacity.`,
      );
    this.canvas.width = width;
    this.canvas.height = height;
    const p = this.context;
    p.scale(scale, scale);
    {
      const t = command.text;
      p.font = t.font;
      p.fillStyle = t.color;
      p.textBaseline = "alphabetic";
      const metrics = p.measureText("Mg");
      const ascent = metrics.fontBoundingBoxAscent ?? t.size,
        descent = metrics.fontBoundingBoxDescent ?? t.size * 0.25;
      p.letterSpacing = `${t.tracking}px`;
      t.lines.forEach((line, i) => {
        const x =
          t.align === "center"
            ? (b.width - t.widths[i]) / 2
            : t.align === "right"
              ? b.width - t.widths[i]
              : 0;
        const y =
          i * t.lineHeight + (t.lineHeight - ascent - descent) / 2 + ascent;
        p.fillText(line, x, y);
      });
    }
    const texture = context.device.createTexture({
      label: command.path,
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      context.device.queue.copyExternalImageToTexture(
        { source: this.canvas },
        { texture },
        [width, height],
      );
      this.budget.textBytes += bytes;
      this.budget.textEntries++;
      return { texture, bytes };
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }
  /**
   * First shared-transition correction this paint can follow, or undefined when the transition
   * supplies none. `correctionIds` is ordered innermost-first, so an inner ID this transition
   * did not match falls back to an enclosing one. Exactly one matrix is ever returned.
   */
  private resolveCorrection(
    command: DrawCommand,
    context: RenderContext,
  ): readonly number[] | undefined {
    const ids = command.correctionIds ?? [
      ...(command.sharedId ? [command.sharedId] : []),
      ...(command.matchId ? [command.matchId] : []),
    ];
    for (const id of ids) {
      const correction = context.sharedTransforms?.get(id);
      if (correction) return correction;
    }
    return undefined;
  }
  /** Reconciled Clip traces from the last successful collecting render. Empty otherwise. */
  surfaceTraces(): readonly SurfaceTrace[] {
    return this.surfaceProjection;
  }
  /** Frame visits from the last successful collecting render. Empty when inspection is off. */
  frameOccurrences(): readonly FrameOccurrence[] {
    return this.frameOccurrenceSnapshot;
  }
  /** Same finished traces as {@link surfaceTraces}. Absent is the stage's job, not this array. */
  surfaceOccurrences(): readonly SurfaceTrace[] {
    return this.surfaceProjection;
  }
  render(
    frame: EvaluatedFrame,
    context: RenderContext,
    size: readonly [number, number],
    background: string,
    debug: boolean,
    textResolution = 1,
    clear = true,
    media: ReadonlyMap<string, ImageTexture> = new Map(),
    collector?: (record: PaintRecord) => void,
  ) {
    const incoming = this.tracePass;
    this.tracePass = undefined;
    // Root snapshot dies before the readiness throw, which is outside the catch.
    if (!incoming) {
      this.surfaceProjection = EMPTY_SURFACE_TRACES;
      this.frameOccurrenceSnapshot = EMPTY_FRAME_OCCURRENCES;
    }
    if (this.disposed || !this.pipeline || !this.white || !this.sampler)
      throw Error("View renderer is not ready.");
    let book = incoming?.book;
    let sink = incoming?.sink;
    const blocked = incoming?.blocked;
    // No book and no counter unless this render is collecting or continuing a trace.
    if (collector || incoming) {
      book ??= new SurfaceProjectionTraces();
      sink ??= book.roots;
    }
    try {
      const {
        scale,
        ox,
        oy,
        matrix: frameMatrix,
      } = computeFrameTransform(size, context.resolution, frame.camera?.matrix);
      const scissorX = Math.ceil(ox);
      const scissorY = Math.ceil(oy);
      const scissorW = Math.max(
        0,
        Math.floor(context.resolution[0] - ox) - scissorX,
      );
      const scissorH = Math.max(
        0,
        Math.floor(context.resolution[1] - oy) - scissorY,
      );
      if (incoming?.occurrenceId !== undefined)
        incoming.book.noteChildScissor(incoming.occurrenceId, {
          x: scissorX,
          y: scissorY,
          width: scissorW,
          height: scissorH,
        });
      const frameId = book?.beginFrame({
        layoutSpace: frame.frameLayoutSpaceId
          ? { status: "known", id: frame.frameLayoutSpaceId }
          : { status: "unavailable", reason: MISSING_LAYOUT_SPACE_REASON },
        targetResolution: [context.resolution[0], context.resolution[1]],
        designSize: [size[0], size[1]],
        scissor: {
          x: scissorX,
          y: scissorY,
          width: scissorW,
          height: scissorH,
        },
        parentSurface:
          incoming?.occurrenceId !== undefined
            ? { status: "known", occurrenceId: incoming.occurrenceId }
            : {
                status: "unavailable",
                reason: incoming ? NON_CLIP_PARENT_REASON : ROOT_TARGET_REASON,
              },
        baseFrameTransform: baseFrameMapping(frameMatrix),
      });
      if (incoming?.childFrame && frameId !== undefined)
        incoming.childFrame.id = frameId;
      const slots: PublishSlot[] | undefined = collector ? [] : undefined;
      const rasterScale = scale * textResolution;
      const activeSurfaces = new Set(
        frame.commands
          .filter((c) => c.kind === "composition" || c.kind === "group")
          .map((c) => c.path),
      );
      for (const [key, surface] of this.surfaces)
        if (!activeSurfaces.has(key)) {
          this.releaseSurface(surface);
          this.surfaces.delete(key);
        }
      const compositionTextures = new Map<string, GPUTexture>();
      for (const c of frame.commands)
        if (c.kind === "composition" || c.kind === "group") {
          const plan = planSurface(
            c.bounds,
            c.transform,
            scale,
            frameMatrix,
            context.sharedSpace,
          );
          const { width, height } = plan;
          let surface = this.surfaces.get(c.path);
          if (
            surface &&
            (surface.width !== width || surface.height !== height)
          ) {
            this.releaseSurface(surface);
            this.surfaces.delete(c.path);
            surface = undefined;
          }
          if (!surface) {
            if (
              width > context.device.limits.maxTextureDimension2D ||
              height > context.device.limits.maxTextureDimension2D ||
              this.budget.bytes + width * height * 4 > 256 * 1024 * 1024
            )
              throw Error(
                `${c.path}: composition surfaces exceed device or 256 MiB budget.`,
              );
            const texture = context.device.createTexture({
              label: c.path,
              size: [width, height],
              format: context.format,
              usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST,
            });
            surface = {
              texture,
              world: this.fork(),
              width,
              height,
            };
            this.budget.bytes += width * height * 4;
            this.surfaces.set(c.path, surface);
          }
          const { childSpace } = plan;
          // A surface transformed as one unit must not let its contents apply a pose again.
          // That is decided here, from the matrix the transition actually supplies, rather than
          // from candidate names or from a declared ID: a surface may list candidates this
          // transition did not match while a descendant is matched, and those descendants must
          // still animate.
          const surfaceCorrected =
            this.resolveCorrection(c, context) !== undefined;
          const childContext = {
            ...context,
            sharedTransforms: surfaceCorrected
              ? undefined
              : context.sharedTransforms,
            sharedSpace: childSpace,
            target: surface.texture,
            resolution: [width, height] as const,
          };
          const childSize = plan.childDesignSize;
          // Paint collector stays on this render. A fork receives the book even with no
          // tagged surface, so every visit still gets a frame id.
          let childPass: SurfaceTracePass | undefined;
          if (book && frameId !== undefined) {
            if (isTaggedSurface(c)) {
              const opened = book.open(
                c.inspection.id,
                c.inspection.nodeId,
                c.path,
                c.inspectionSurface,
                [width, height],
                frameId,
              );
              childPass = {
                book,
                sink: opened.nested,
                paints: opened.paints,
                occurrenceId: c.inspection.id,
              };
            } else {
              childPass = {
                book,
                sink: sink ?? book.roots,
                blocked: blocked ?? NON_CLIP_PARENT_REASON,
              };
            }
          }
          const worldSlot = childPass ? { id: undefined as number | undefined } : undefined;
          surface.world.tracePass = childPass
            ? { ...childPass, childFrame: worldSlot }
            : undefined;
          try {
            surface.world.render(
              c.frame,
              childContext,
              childSize,
              "#00000000",
              debug,
              textResolution,
              true,
              media,
            );
          } finally {
            surface.world.tracePass = undefined;
          }
          if (
            book &&
            isTaggedSurface(c) &&
            worldSlot?.id !== undefined &&
            c.kind === "composition"
          )
            book.noteRenderedFrame(c.inspection.id, "world", worldSlot.id);
          if (c.overlay) {
            surface.overlay ??= this.fork();
            const overlaySlot = childPass
              ? { id: undefined as number | undefined }
              : undefined;
            surface.overlay.tracePass = childPass
              ? { ...childPass, childFrame: overlaySlot }
              : undefined;
            try {
              surface.overlay.render(
                c.overlay,
                childContext,
                childSize,
                "#00000000",
                debug,
                textResolution,
                false,
                media,
              );
            } finally {
              surface.overlay.tracePass = undefined;
            }
            if (
              book &&
              isTaggedSurface(c) &&
              overlaySlot?.id !== undefined
            )
              book.noteRenderedFrame(c.inspection.id, "overlay", overlaySlot.id);
          } else {
            surface.overlay?.dispose();
            surface.overlay = undefined;
          }
          compositionTextures.set(c.path, surface.texture);
        }
      const commands = [...frame.commands];
      if (debug) {
        const visit = (node: EvaluatedFrame["tree"]) => {
          commands.push({
            kind: "box",
            path: node.path,
            bounds: node.bounds,
            transform: node.transform,
            opacity: 1,
            fill: "#00000000",
            radius: 0,
            stroke: "#E43A79",
            strokeWidth: 1 / (scale * (frame.camera?.zoom ?? 1)),
          });
          if (node.kind !== "composition" && node.kind !== "group")
            node.children.forEach(visit);
        };
        visit(frame.tree);
      }
      const keys = new Set(
        commands.flatMap((c) =>
          c.kind === "text"
            ? [
                this.textKey(
                  c.text,
                  c.bounds.width,
                  c.bounds.height,
                  rasterScale,
                ),
              ]
            : [],
        ),
      );
      for (const [key, entry] of this.texts)
        if (!keys.has(key)) {
          this.releaseText(entry);
          this.texts.delete(key);
        }
      const stride = Math.max(
        256,
        context.device.limits.minUniformBufferOffsetAlignment,
      );
      const bytes = Math.max(stride, commands.length * stride);
      if (bytes > context.device.limits.maxBufferSize)
        throw Error("View draw list exceeds GPU buffer capacity.");
      if (!this.uniform || this.uniform.size < bytes) {
        this.uniform?.destroy();
        this.uniform = context.device.createBuffer({
          size: bytes,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      const values = new Float32Array(bytes / 4);
      // shortcut: one binding/draw per primitive, batch only after real workload measurements.
      const edgeValues: number[] = [];
      const edgeRanges = commands.map((c) => {
        const offset = edgeValues.length * 4;
        const outline =
          c.kind === "path"
            ? c.outline
            : c.kind === "composition"
              ? c.mask
              : undefined;
        if (outline)
          for (const contour of flattenPath(outline))
            contour.forEach((p, i) =>
              edgeValues.push(...p, ...contour[(i + 1) % contour.length]),
            );
        const count = (edgeValues.length * 4 - offset) / 16;
        const alignment = context.device.limits.minStorageBufferOffsetAlignment;
        while ((edgeValues.length * 4) % alignment) edgeValues.push(0);
        return { offset, count };
      });
      const edgeBytes = Math.max(16, edgeValues.length * 4 + 16);
      if (edgeBytes > context.device.limits.maxStorageBufferBindingSize)
        throw Error("Path edges exceed GPU storage budget.");
      if (!this.edgeBuffer || this.edgeBuffer.size < edgeBytes) {
        this.edgeBuffer?.destroy();
        this.edgeBuffer = context.device.createBuffer({
          size: edgeBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
      }
      if (edgeValues.length)
        context.device.queue.writeBuffer(
          this.edgeBuffer,
          0,
          new Float32Array(edgeValues),
        );
      const bindings: GPUBindGroup[] = [];
      commands.forEach((c, i) => {
        try {
          let texture =
            c.kind === "composition" || c.kind === "group"
              ? compositionTextures.get(c.path)!
              : this.white!;
          if (c.kind === "text") {
            const key = this.textKey(
              c.text,
              c.bounds.width,
              c.bounds.height,
              rasterScale,
            );
            let cached = this.texts.get(key);
            if (!cached) {
              this.color(c.text.color);
              cached = this.rasterText(c, rasterScale, context);
              this.texts.set(key, cached);
            }
            texture = cached.texture;
          }
          let b = c.bounds;
          let uv: readonly number[] = [1, 1, 0, 0];
          if (c.kind === "media") {
            const resource = media.get(mediaKey(c.source));
            if (!resource)
              throw Error("Media is not prepared; use renderAsync().");
            const fitted = fitMedia(
              b.width,
              b.height,
              resource.width,
              resource.height,
              c.crop ? "cover" : (c.source.style.fit ?? "contain"),
            );
            b = {
              x: b.x + fitted.x,
              y: b.y + fitted.y,
              width: fitted.width,
              height: fitted.height,
            };
            uv = fitted.uv;
            if (c.crop) {
              const [x, y, zoom] = c.crop;
              const u = fitted.uv[0] / zoom,
                v = fitted.uv[1] / zoom;
              uv = [
                u,
                v,
                Math.max(0, Math.min(1 - u, x - u / 2)),
                Math.max(0, Math.min(1 - v, y - v / 2)),
              ];
            }
            texture = resource.texture;
          }
          const [sx, sy, tx, ty] = c.transform;
          let drawCamera: readonly number[] = frameMatrix;
          // Matching identity decides *whether* a shared transition has a pose; the paint
          // correction applies it to the whole declaring chain, so a background and the
          // content it decorates move together in both modifier orders.
          const correction = this.resolveCorrection(c, context);
          if (correction) {
            const space = context.sharedSpace ?? identity;
            drawCamera = multiply(
              multiply(multiply(inverse(space), correction), space),
              drawCamera,
            );
          }
          values.set(
            [
              b.x,
              b.y,
              b.width,
              b.height,
              sx,
              sy,
              tx,
              ty,
              ...context.resolution,
              c.kind === "box" ? c.radius : 0,
              c.kind === "box" ? c.strokeWidth : 0,
              ...(c.kind === "box" || c.kind === "path"
                ? this.color(c.fill)
                : [1, 1, 1, 1]),
              ...(c.kind === "box" && c.stroke
                ? this.color(c.stroke)
                : [0, 0, 0, 0]),
              c.opacity,
              c.kind === "box"
                ? 0
                : c.kind === "composition" || c.kind === "group"
                  ? c.kind === "composition" && c.imageMask
                    ? c.imageMask.mode === "luminance"
                      ? 6
                      : 5
                    : c.kind === "composition" && c.mask
                      ? 4
                      : 2
                  : c.kind === "path"
                    ? 3
                    : 1,
              edgeRanges[i].count,
              (c.kind === "path" && c.fillRule === "evenodd") ||
              (c.kind === "composition" && c.maskFillRule === "evenodd")
                ? 1
                : 0,
              drawCamera[0],
              drawCamera[2],
              drawCamera[4],
              0,
              drawCamera[1],
              drawCamera[3],
              drawCamera[5],
              0,
              ...uv,
            ],
            (i * stride) / 4,
          );
          // Collected after the upload, so a record describes the uniforms the GPU receives.
          // A tagged surface is replaced by its leaves. An untagged surface stays unsupported.
          // Debug outlines are appended to the copy above, so `frame.commands` is only real paint.
          if (
            book &&
            frameId !== undefined &&
            i < frame.commands.length &&
            c.inspection
          )
            book.noteDrawCamera(frameId, {
              commandId: c.inspection.id,
              ownerNodeId: c.inspection.nodeId,
              camera: uploadedCameraMapping(values, (i * stride) / 4),
            });
          if (book && i < frame.commands.length && isTaggedSurface(c)) {
            // Child traces were accepted before this uniform existed; reconcile only now.
            const raw = book.close(
              c.inspection.id,
              copySurfaceUniform(values, (i * stride) / 4),
              blocked,
            );
            if (raw) (blocked ? book.blocked : (sink ?? book.roots)).push(raw);
          }
          if (incoming?.paints && i < frame.commands.length) {
            if (isTaggedSurface(c))
              incoming.paints.push({
                kind: "nested",
                occurrenceId: c.inspection.id,
              });
            else if (
              c.kind === "box" ||
              c.kind === "text" ||
              c.kind === "media"
            )
              incoming.paints.push(
                captureLeaf(c, values, (i * stride) / 4),
              );
            else incoming.paints.push(captureBoundary(c));
          }
          if (slots && i < frame.commands.length) {
            if (isTaggedSurface(c))
              slots.push({ kind: "surface", occurrenceId: c.inspection.id });
            else
              slots.push({
                kind: "record",
                record: paintRecord(c, values, (i * stride) / 4),
              });
          }
          bindings.push(
            context.device.createBindGroup({
              layout: this.pipeline!.getBindGroupLayout(0),
              entries: [
                {
                  binding: 0,
                  resource: {
                    buffer: this.uniform!,
                    offset: i * stride,
                    size: 144,
                  },
                },
                { binding: 1, resource: texture.createView() },
                { binding: 2, resource: this.sampler! },
                {
                  binding: 4,
                  resource: (() => {
                    if (c.kind !== "composition" || !c.imageMask)
                      return this.white!.createView();
                    const mask = media.get(
                      mediaKey({
                        kind: "image",
                        url: c.imageMask.url,
                        style: { width: b.width, height: b.height },
                      }),
                    );
                    if (!mask)
                      throw Error(
                        "Mask image is not prepared; use renderAsync().",
                      );
                    return mask.texture.createView();
                  })(),
                },
                {
                  binding: 3,
                  resource: {
                    buffer: this.edgeBuffer!,
                    offset: edgeRanges[i].offset,
                    size: Math.max(16, edgeRanges[i].count * 16),
                  },
                },
              ],
            }),
          );
        } catch (error) {
          throw Error(
            `${c.path}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      });
      context.device.queue.writeBuffer(this.uniform, 0, values);
      const [r, g, b, a] = this.color(background);
      const pass = context.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.target.createView(),
            loadOp: clear ? "clear" : "load",
            storeOp: "store",
            clearValue: { r, g, b, a },
          },
        ],
      });
      pass.setScissorRect(scissorX, scissorY, scissorW, scissorH);
      pass.setPipeline(this.pipeline);
      bindings.forEach((bind) => {
        pass.setBindGroup(0, bind);
        pass.draw(6);
      });
      pass.end();
      if (!incoming) {
        this.surfaceProjection = book?.finish() ?? EMPTY_SURFACE_TRACES;
        this.frameOccurrenceSnapshot =
          book?.frameOccurrences() ?? EMPTY_FRAME_OCCURRENCES;
        if (collector && slots) {
          const rootResolution: readonly [number, number] = [
            context.resolution[0],
            context.resolution[1],
          ];
          const rootWindow: TargetWindow = {
            resolution: rootResolution,
            scissor: {
              x: scissorX,
              y: scissorY,
              width: scissorW,
              height: scissorH,
            },
          };
          const projected = new Map<number, PaintRecord[]>();
          for (const clip of book?.roots ?? []) {
            const records: PaintRecord[] = [];
            projectNode(
              clip,
              [],
              undefined,
              rootWindow,
              rootResolution,
              records,
            );
            projected.set(clip.occurrenceId, records);
          }
          for (const slot of slots) {
            if (slot.kind === "record") {
              collector(slot.record);
              continue;
            }
            const records = projected.get(slot.occurrenceId) ?? [];
            for (const record of records) collector(record);
          }
        }
      }
    } catch (error) {
      if (!incoming) {
        this.surfaceProjection = EMPTY_SURFACE_TRACES;
        this.frameOccurrenceSnapshot = EMPTY_FRAME_OCCURRENCES;
      }
      throw error;
    }
  }
  private releaseSurface(surface: {
    texture: GPUTexture;
    world: ViewRenderer;
    overlay?: ViewRenderer;
    width: number;
    height: number;
  }) {
    surface.texture.destroy();
    surface.world.dispose();
    surface.overlay?.dispose();
    this.budget.bytes -= surface.width * surface.height * 4;
  }
  private releaseText(entry: CachedText) {
    entry.texture.destroy();
    this.budget.textBytes -= entry.bytes;
    this.budget.textEntries--;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.uniform?.destroy();
    this.edgeBuffer?.destroy();
    if (this.ownsShared) this.white?.destroy();
    for (const surface of this.surfaces.values()) this.releaseSurface(surface);
    this.surfaces.clear();
    for (const entry of this.texts.values()) this.releaseText(entry);
    this.texts.clear();
    this.canvas.width = this.canvas.height = 0;
    this.surfaceProjection = EMPTY_SURFACE_TRACES;
    this.frameOccurrenceSnapshot = EMPTY_FRAME_OCCURRENCES;
    this.tracePass = undefined;
  }
}
