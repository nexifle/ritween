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
 * the shader painted: radius, stroke width, color alpha, antialiasing, scissor, occlusion, and
 * compositing all live inside that quad. Shared-element corrections are already part of the draw
 * camera, so `space` stays the pre-transition scene target, not final transition output.
 * `accuracy` is the discriminant: `unavailable` means no rectangle this collector can honestly
 * record, so coverage stays partial instead of claiming the paint is out of frame.
 */
export type PaintRecord = {
  readonly kind: DrawCommand["kind"];
  readonly path: string;
  /** Present only when the frame was evaluated with inspection enabled. */
  readonly inspection?: InspectionIdentity;
  readonly paintRole: "content" | "background";
  readonly space: "scene-target-pixels";
  readonly resolution: readonly [number, number];
} & (
  | {
      /**
       * `exact-rectangle` when the ideal projection keeps the quad axis-aligned; `conservative`
       * carries its AABB. Neither encloses GPU rounding.
       */
      readonly accuracy: "exact-rectangle" | "conservative";
      /** Ideal projected quad AABB in `space`, from the uploaded float32 uniforms. */
      readonly bounds: Bounds;
      readonly provenance: "projected-box-draw-quad";
      /**
       * Positive area, invertible matrix, and nonzero opacity of that ideal quad. Geometry only,
       * never proof that a fragment was visible.
       */
      readonly geometryVisible: boolean;
      readonly unsupported?: never;
    }
  | {
      readonly accuracy: "unavailable";
      readonly unsupported: string;
      readonly bounds?: never;
    }
);

/** One float32 vertex stage; a stage leaving the finite range makes the quad unavailable below. */
function stage32(value: number, label: string): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded))
    throw new RangeError(`${label} overflows float32.`);
  return rounded;
}

/**
 * Rejects vertex stages that leave float32 while every uniform stays finite:
 * `(rect.xy + uv * rect.zw) * transform.xy + transform.zw` through both camera rows. Real GPUs
 * may fuse or widen these steps, so this is a safety check, never a rounding model.
 */
function checkVertexFloat32(
  rect: readonly [number, number, number, number],
  transform: readonly [number, number, number, number],
  cameraX: readonly [number, number, number],
  cameraY: readonly [number, number, number],
) {
  const [x, y, width, height] = rect;
  const [sx, sy, tx, ty] = transform;
  for (const u of [0, 1])
    for (const v of [0, 1]) {
      const worldX = stage32(
        stage32(stage32(x + u * width, "rect x") * sx, "transform x") + tx,
        "transform x",
      );
      const worldY = stage32(
        stage32(stage32(y + v * height, "rect y") * sy, "transform y") + ty,
        "transform y",
      );
      // The product sum is staged before the constant: two float32 products can overflow while
      // a cancelling constant brings the unstaged total back into range. Neither order is proven
      // GPU behaviour, so this stays a conservative check.
      for (const [row, label] of [
        [cameraX, "camera X"],
        [cameraY, "camera Y"],
      ] as const)
        stage32(
          stage32(
            stage32(row[0] * worldX, label) + stage32(row[1] * worldY, label),
            label,
          ) + row[2],
          label,
        );
    }
}

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
  if (command.kind !== "box")
    return unsupported(
      `${command.kind} paint is not collected; only top-level Box draw quads are.`,
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
  return {
    ...identity,
    accuracy:
      projected.accuracy === "exact" ? "exact-rectangle" : "conservative",
    bounds: projected.bounds,
    provenance: "projected-box-draw-quad",
    geometryVisible: projected.visible,
  };
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
    if (this.disposed || !this.pipeline || !this.white || !this.sampler)
      throw Error("View renderer is not ready.");
    const {
      scale,
      ox,
      oy,
      matrix: frameMatrix,
    } = computeFrameTransform(size, context.resolution, frame.camera?.matrix);
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
        if (surface && (surface.width !== width || surface.height !== height)) {
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
        if (c.overlay) {
          surface.overlay ??= this.fork();
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
          ? [this.textKey(c.text, c.bounds.width, c.bounds.height, rasterScale)]
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
        // Nested world/overlay surfaces render through forked renderers that get no collector,
        // so a surface reports itself unsupported instead of forwarding into a tree it skips.
        // Debug outlines are appended to the copy above, so `frame.commands` is only real paint.
        if (collector && i < frame.commands.length)
          collector(paintRecord(c, values, (i * stride) / 4));
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
    pass.setScissorRect(
      Math.ceil(ox),
      Math.ceil(oy),
      Math.max(0, Math.floor(context.resolution[0] - ox) - Math.ceil(ox)),
      Math.max(0, Math.floor(context.resolution[1] - oy) - Math.ceil(oy)),
    );
    pass.setPipeline(this.pipeline);
    bindings.forEach((bind) => {
      pass.setBindGroup(0, bind);
      pass.draw(6);
    });
    pass.end();
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
  }
}
