import type {
  FramePreparationContext,
  MediaClip,
  RenderContext,
  Scene,
  SceneEntry,
  SetupContext,
} from "../types";
import { fetchAsset } from "../media/resource";
import { openVideo } from "../decode/video-resource";
import { validateMediaClip } from "../media/project";

export interface ImageTexture {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  dispose(): void;
}
export interface VideoTexture extends ImageTexture {
  prepareFrame(
    context: Pick<FramePreparationContext, "time" | "signal">,
  ): Promise<void>;
}
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;
const textureBytes = new WeakMap<GPUDevice, number>();
const releases = new WeakMap<GPUTexture, () => void>();
function releaseTexture(value: GPUTexture) {
  releases.get(value)?.();
  releases.delete(value);
}
function texture(device: GPUDevice, width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > device.limits.maxTextureDimension2D ||
    height > device.limits.maxTextureDimension2D ||
    width * height * 4 + (textureBytes.get(device) ?? 0) > MAX_TEXTURE_BYTES
  )
    throw Error("Media textures exceed the device or shared 64 MiB limit.");
  const bytes = width * height * 4;
  const result = device.createTexture({
    size: [width, height],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  textureBytes.set(device, (textureBytes.get(device) ?? 0) + bytes);
  releases.set(result, () => {
    result.destroy();
    textureBytes.set(
      device,
      Math.max(0, (textureBytes.get(device) ?? bytes) - bytes),
    );
  });
  return result;
}

export async function loadImageTexture(
  context: SetupContext,
  options: { url: string; signal?: AbortSignal },
): Promise<ImageTexture> {
  const bytes = await fetchAsset(options.url, options.signal);
  options.signal?.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([bytes]));
  let result: GPUTexture | undefined;
  try {
    options.signal?.throwIfAborted();
    result = texture(context.device, bitmap.width, bitmap.height);
    context.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: result },
      [bitmap.width, bitmap.height],
    );
    return {
      texture: result,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => {
        if (result) releaseTexture(result);
      },
    };
  } catch (error) {
    if (result) releaseTexture(result);
    throw error;
  } finally {
    bitmap.close();
  }
}

/** Daftarkan descriptor pada project.mediaClips atau scene.mediaClips untuk audio terkait. */
export function videoResource(options: MediaClip): Readonly<MediaClip> {
  validateMediaClip(options);
  return Object.freeze({ ...options });
}

export async function loadVideoTexture(
  context: SetupContext,
  clip: MediaClip,
  signal?: AbortSignal,
): Promise<VideoTexture> {
  validateMediaClip(clip);
  const input = await openVideo(clip.url, signal);
  let target: GPUTexture;
  try {
    signal?.throwIfAborted();
    if ((clip.offset ?? 0) + clip.duration > input.duration + 1e-6)
      throw Error(`Video trim exceeds source duration: ${clip.id}`);
    target = texture(context.device, input.width, input.height);
  } catch (error) {
    input.dispose();
    throw error;
  }
  let disposed = false;
  return {
    texture: target,
    width: input.width,
    height: input.height,
    async prepareFrame({ time, signal: requestSignal }) {
      if (disposed) throw Error(`Video texture is disposed: ${clip.id}`);
      if (!Number.isFinite(time)) throw Error("Media time must be finite.");
      const local = Math.max(0, Math.min(clip.duration, time - clip.start));
      const end = (clip.offset ?? 0) + clip.duration;
      const sourceTime = Math.min(
        (clip.offset ?? 0) + local,
        end - Math.min(1e-7, clip.duration / 2),
      );
      const frame = await input.frameAt(sourceTime, requestSignal);
      try {
        requestSignal?.throwIfAborted();
        if (disposed) throw Error(`Video texture is disposed: ${clip.id}`);
        context.device.queue.copyExternalImageToTexture(
          { source: frame },
          { texture: target },
          [input.width, input.height],
        );
      } finally {
        frame.close();
      }
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        input.dispose();
        releaseTexture(target);
      }
    },
  };
}

export interface MediaTransform {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
}
export interface VisualOptions {
  id: string;
  name: string;
  source: string;
  start: number;
  fit?: "contain" | "cover";
  transform?: MediaTransform | ((context: RenderContext) => MediaTransform);
  background?: readonly [number, number, number, number];
}

const SHADER = `
struct Controls { resolution: vec2f, position: vec2f, size: vec2f, rotation: f32, opacity: f32, uvScale: vec2f, uvOffset: vec2f };
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> controls: Controls;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let corners = array<vec2f, 6>(vec2f(-0.5,-0.5),vec2f(0.5,-0.5),vec2f(-0.5,0.5),vec2f(-0.5,0.5),vec2f(0.5,-0.5),vec2f(0.5,0.5));
  let corner = corners[i];
  let p = corner * controls.size;
  let c = cos(controls.rotation); let s = sin(controls.rotation);
  let pixel = controls.position + vec2f(c*p.x-s*p.y,s*p.x+c*p.y);
  var result: Vertex;
  result.position = vec4f(pixel.x/controls.resolution.x*2.-1.,1.-pixel.y/controls.resolution.y*2.,0.,1.);
  result.uv = (corner+0.5)*controls.uvScale+controls.uvOffset;
  return result;
}
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  let color = textureSample(image,imageSampler,input.uv);
  return vec4f(color.rgb,color.a*controls.opacity);
}`;

function visualScene(
  options: VisualOptions,
  load: (
    context: SetupContext,
    signal: AbortSignal,
  ) => Promise<ImageTexture | VideoTexture>,
  asynchronous = false,
): Scene {
  let resource: ImageTexture | VideoTexture | undefined;
  let pipeline: GPURenderPipeline;
  let bind: GPUBindGroup;
  let uniform: GPUBuffer | undefined;
  const lifetime = new AbortController();
  return {
    async setup(context) {
      resource = await load(context, lifetime.signal);
      if (lifetime.signal.aborted) {
        resource.dispose();
        lifetime.signal.throwIfAborted();
      }
      try {
        const shader = context.device.createShaderModule({ code: SHADER });
        pipeline = await context.device.createRenderPipelineAsync({
          layout: "auto",
          vertex: { module: shader, entryPoint: "vertex" },
          fragment: {
            module: shader,
            entryPoint: "fragment",
            targets: [
              {
                format: context.format,
                blend: {
                  color: {
                    srcFactor: "src-alpha",
                    dstFactor: "one-minus-src-alpha",
                    operation: "add",
                  },
                  alpha: {
                    srcFactor: "one",
                    dstFactor: "one-minus-src-alpha",
                    operation: "add",
                  },
                },
              },
            ],
          },
          primitive: { topology: "triangle-list" },
        });
        lifetime.signal.throwIfAborted();
        uniform = context.device.createBuffer({
          size: 48,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        bind = context.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: resource.texture.createView() },
            {
              binding: 1,
              resource: context.device.createSampler({
                magFilter: "linear",
                minFilter: "linear",
              }),
            },
            { binding: 2, resource: { buffer: uniform } },
          ],
        });
      } catch (error) {
        resource.dispose();
        uniform?.destroy();
        throw error;
      }
    },
    prepareFrame: asynchronous
      ? async (context: FramePreparationContext) => {
          lifetime.signal.throwIfAborted();
          if (resource && "prepareFrame" in resource)
            await resource.prepareFrame(context);
        }
      : undefined,
    render(context) {
      if (!resource || !uniform) throw Error("Media scene is not ready.");
      const reference = context.compositionResolution ?? context.resolution;
      const transform =
        typeof options.transform === "function"
          ? options.transform({ ...context, resolution: reference })
          : (options.transform ?? {});
      const scaleX = context.resolution[0] / reference[0];
      const scaleY = context.resolution[1] / reference[1];
      let width = transform.width ?? reference[0];
      let height = transform.height ?? reference[1];
      const ratio = resource.width / resource.height;
      const boxRatio = width / height;
      let sx = 1,
        sy = 1;
      if ((options.fit ?? "contain") === "contain") {
        if (boxRatio > ratio) width = height * ratio;
        else height = width / ratio;
      } else {
        if (boxRatio > ratio) sy = ratio / boxRatio;
        else sx = boxRatio / ratio;
      }
      const values = [
        context.resolution[0],
        context.resolution[1],
        (transform.x ?? reference[0] / 2) * scaleX,
        (transform.y ?? reference[1] / 2) * scaleY,
        width * scaleX,
        height * scaleY,
        transform.rotation ?? 0,
        transform.opacity ?? 1,
        sx,
        sy,
        (1 - sx) / 2,
        (1 - sy) / 2,
      ];
      if (
        !values.every(Number.isFinite) ||
        width <= 0 ||
        height <= 0 ||
        values[7] < 0 ||
        values[7] > 1
      )
        throw Error(`Invalid media transform: ${options.id}`);
      context.device.queue.writeBuffer(uniform, 0, new Float32Array(values));
      const color = options.background ?? [0, 0, 0, 1];
      const pass = context.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.target.createView(),
            clearValue: { r: color[0], g: color[1], b: color[2], a: color[3] },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(6);
      pass.end();
    },
    dispose() {
      lifetime.abort();
      resource?.dispose();
      uniform?.destroy();
    },
  };
}

export function imageScene(
  options: VisualOptions & { url: string; duration: number },
): SceneEntry {
  return {
    id: options.id,
    name: options.name,
    source: options.source,
    start: options.start,
    duration: options.duration,
    transition: { type: "cut" },
    create: () =>
      visualScene(options, (context, signal) =>
        loadImageTexture(context, { url: options.url, signal }),
      ),
  };
}

export function videoClip(
  options: VisualOptions & {
    url: string;
    trim: { in: number; out: number };
    audio?: { muted?: boolean; volume?: number };
  },
): SceneEntry {
  const clip = videoResource({
    id: options.id,
    name: options.name,
    url: options.url,
    start: options.start,
    offset: options.trim.in,
    duration: options.trim.out - options.trim.in,
    muted: options.audio?.muted,
    volume: options.audio?.volume,
  });
  return {
    id: options.id,
    name: options.name,
    source: options.source,
    start: options.start,
    duration: clip.duration,
    transition: { type: "cut" },
    mediaClips: [clip],
    create: () =>
      visualScene(
        options,
        (context, signal) => loadVideoTexture(context, clip, signal),
        true,
      ),
  };
}
