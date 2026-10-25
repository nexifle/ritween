import type { Scene, SetupContext, RenderContext } from "../../engine/types";
const font: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": Array(7).fill("00000"),
};
export function shaderScene(
  fragment: string,
  title: string,
  mode: number,
): Scene {
  let pipeline: GPURenderPipeline,
    uniform: GPUBuffer,
    glyphs: GPUBuffer,
    bind: GPUBindGroup;
  return {
    async setup({ device, format }: SetupContext) {
      uniform = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const rows = new Uint32Array(
        Array.from(title).flatMap((c) =>
          (font[c] ?? font[" "]).map((row) => parseInt(row, 2)),
        ),
      );
      glyphs = device.createBuffer({
        size: Math.max(4, rows.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(glyphs, 0, rows);
      const module = device.createShaderModule({
        code: shaderHeader + fragment,
      });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length)
        throw Error(
          errors
            .map((m) => `WGSL ${m.lineNum}:${m.linePos}: ${m.message}`)
            .join("\n"),
        );
      pipeline = await device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module, entryPoint: "vertex" },
        fragment: { module, entryPoint: "fragment", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: glyphs } },
        ],
      });
    },
    render({
      device,
      encoder,
      target,
      resolution,
      localTime,
      progress,
    }: RenderContext) {
      device.queue.writeBuffer(
        uniform,
        0,
        new Float32Array([
          resolution[0],
          resolution[1],
          localTime,
          progress,
          title.length,
          mode,
          0,
          0,
        ]),
      );
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    },
    dispose() {
      uniform?.destroy();
      glyphs?.destroy();
    },
  };
}
const shaderHeader = /* wgsl */ `
struct Params { resolution:vec2f, time:f32, progress:f32, letters:f32, mode:f32, pad:vec2f }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> glyphs:array<u32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
fn text(uv:vec2f, center:vec2f, height:f32)->f32 {
 let cell=height/7.; let width=(u.letters*6.-1.)*cell;
 let p=(uv-center+vec2f(width*.5,height*.5))/cell;
 let col=i32(floor(p.x));let row=i32(floor(p.y));let letter=col/6;let x=col%6;
 if(p.x<0. || row<0 || row>=7 || x>=5 || letter>=i32(u.letters)){return 0.;}
 let bits=glyphs[u32(letter*7+row)];return f32((bits>>u32(4-x))&1u);
}
fn orbit(p:vec2f,t:f32)->vec3f {
 var color=vec3f(0.); let tau=6.2831853;
 for(var j=0;j<9;j++) {
  let f=f32(j);let a=t*.19+f*.19;let c=cos(a);let s=sin(a);
  let q=vec2f(c*p.x-s*p.y,s*p.x+c*p.y);
  let radius=.42+f*.022;let d=abs(length(q*vec2f(1.,2.2+sin(f*.3+t*.2)*.8))-radius);
  let hue=mix(vec3f(.2,.65,1.),vec3f(.82,.4,1.),f/9.);
  color+=hue*(.0018/(d+.002))*.28;
  let angle=t*(.4+f*.03)+f*tau/9.;
  let dotp=vec2f(c*cos(angle)*radius+s*sin(angle)*radius/2.5,-s*cos(angle)*radius+c*sin(angle)*radius/2.5);
  color+=hue*.00006/(dot(p-dotp,p-dotp)+.00003);
 }
 return color;
}
fn background(uv:vec2f)->vec3f {
 let p=uv-vec2f(.5);var col=vec3f(.018,.028,.068)+vec3f(.03,.04,.10)*max(0.,1.-length(p));
 let grid=abs(fract(uv*vec2f(64.,36.))-.5);let dots=(1.-smoothstep(.025,.06,length(grid)))*.12;
 col+=vec3f(.28,.32,.49)*dots;
 col+=vec3f(.055,.025,.11)*exp(-length(p-vec2f(.28,-.2))*4.);
 return col;
}
`;
