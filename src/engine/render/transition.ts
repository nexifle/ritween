import type { RenderContext, SetupContext, Transition } from "../types";

const directions = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
} as const;

/** [progress, kind, dx, dy]. shared/custom stay kind 0; that is not their visual. */
export function transitionUniform(
  transition: Exclude<Transition, { type: "cut" }> & { progress: number },
): Float32Array<ArrayBuffer> {
  const [dx, dy] = directions[transition.direction ?? "left"];
  return new Float32Array([
    transition.progress,
    Math.max(
      0,
      ["crossfade", "wipe", "slide", "zoom"].indexOf(transition.type),
    ),
    dx,
    dy,
  ]);
}

const code = `
struct Controls { progress: f32, kind: f32, dx: f32, dy: f32 };
@group(0) @binding(0) var outgoing: texture_2d<f32>;
@group(0) @binding(1) var incoming: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> c: Controls;
struct Out { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i:u32)->Out {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
 var o:Out; o.p=vec4f(p[i],0,1); o.uv=vec2f((p[i].x+1)*0.5,(1-p[i].y)*0.5); return o;
}
@fragment fn fs(i:Out)->@location(0) vec4f {
 let p=c.progress; let dir=vec2f(c.dx,c.dy);
 var auv=i.uv; var buv=i.uv; var mixValue=p;
 if(c.kind>0.5 && c.kind<1.5) {
   let axis=select(i.uv.y,i.uv.x,abs(c.dx)>0.5);
   let forward=select(1-axis,axis,c.dx+c.dy>0.);
   mixValue=select(0.,1.,forward<p);
 }
 if(c.kind>1.5 && c.kind<2.5) {
   auv=i.uv-dir*p; buv=i.uv+dir*(1-p);
   mixValue=select(0.,1.,all(buv>=vec2f(0)) && all(buv<=vec2f(1)));
 }
 if(c.kind>2.5) { auv=(i.uv-0.5)/(1+p)+0.5; buv=(i.uv-0.5)/(0.5+0.5*p)+0.5; }
 let a=textureSample(outgoing,samp,auv); let b=textureSample(incoming,samp,buv);
 return mix(a,b,mixValue);
}`;

/** Two reusable render targets, allocated only when a project has overlaps. */
export class TransitionRenderer {
  readonly targets: readonly [GPUTexture, GPUTexture];
  private uniform: GPUBuffer;
  private pipeline: GPURenderPipeline;
  private bind: GPUBindGroup;
  private custom = new Map<string, GPURenderPipeline>();
  private device: GPUDevice;
  private format: GPUTextureFormat;
  constructor(context: SetupContext) {
    const { device, format, resolution } = context;
    this.device = device;
    this.format = format;
    const targets: GPUTexture[] = [];
    let uniform: GPUBuffer | undefined;
    try {
      if (resolution[0] * resolution[1] * 8 > 256 * 1024 * 1024)
        throw Error("Transition targets exceed 256 MiB budget.");
      for (let i = 0; i < 2; i++)
        targets.push(
          device.createTexture({
            label: `Transition ${i}`,
            size: resolution,
            format,
            usage:
              GPUTextureUsage.RENDER_ATTACHMENT |
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_SRC |
              GPUTextureUsage.COPY_DST,
          }),
        );
      uniform = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const module = device.createShaderModule({ code });
      this.pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [
            device.createBindGroupLayout({
              entries: [
                {
                  binding: 0,
                  visibility: GPUShaderStage.FRAGMENT,
                  texture: {},
                },
                {
                  binding: 1,
                  visibility: GPUShaderStage.FRAGMENT,
                  texture: {},
                },
                {
                  binding: 2,
                  visibility: GPUShaderStage.FRAGMENT,
                  sampler: {},
                },
                {
                  binding: 3,
                  visibility: GPUShaderStage.FRAGMENT,
                  buffer: { type: "uniform" },
                },
              ],
            }),
          ],
        }),
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      this.bind = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: targets[0].createView() },
          { binding: 1, resource: targets[1].createView() },
          {
            binding: 2,
            resource: device.createSampler({
              magFilter: "linear",
              minFilter: "linear",
            }),
          },
          { binding: 3, resource: { buffer: uniform } },
        ],
      });
      this.targets = targets as [GPUTexture, GPUTexture];
      this.uniform = uniform;
    } catch (error) {
      targets.forEach((t) => t.destroy());
      uniform?.destroy();
      throw error;
    }
  }
  async prepare(transitions: readonly Transition[]) {
    for (const transition of transitions) {
      if (
        transition.type !== "custom" ||
        !transition.shader ||
        this.custom.has(transition.shader)
      )
        continue;
      const header = code.slice(0, code.indexOf("@fragment fn fs"));
      const module = this.device.createShaderModule({
        code: `${header}\n${transition.shader}\n@fragment fn fs(i:Out)->@location(0) vec4f { return transition(i.uv,c.progress); }`,
      });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length)
        throw Error(
          `Custom transition WGSL: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ")}`,
        );
      const pipeline = await this.device.createRenderPipelineAsync({
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: [this.pipeline.getBindGroupLayout(0)],
        }),
        vertex: { module, entryPoint: "vs" },
        fragment: {
          module,
          entryPoint: "fs",
          targets: [{ format: this.format }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.custom.set(transition.shader, pipeline);
    }
  }
  render(
    context: RenderContext,
    transition: Exclude<Transition, { type: "cut" }> & { progress: number },
  ) {
    context.device.queue.writeBuffer(
      this.uniform,
      0,
      transitionUniform(transition),
    );
    const pass = context.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.target.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    const pipeline =
      transition.type === "custom"
        ? this.custom.get(transition.shader!)
        : this.pipeline;
    if (!pipeline) throw Error("Custom transition shader is not prepared.");
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
  }
  dispose() {
    this.targets.forEach((t) => t.destroy());
    this.uniform.destroy();
    this.custom.clear();
  }
}
