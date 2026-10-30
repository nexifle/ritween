import type { Scene } from "../../engine/types";

// One deterministic display list: flat vector type + projected, cel-shaded meshes.
export const C = {
  paper: "#F4F0E7",
  ink: "#202B38",
  blue: "#4268EC",
  coral: "#F37158",
  lime: "#D6E873",
  muted: "#69717B",
  white: "#FFFFFF",
};
export const clamp = (x: number) => Math.max(0, Math.min(1, x));
export const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
export const smooth = (x: number) => {
  x = clamp(x);
  return x * x * (3 - 2 * x);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
type V = [number, number, number];
export type Face = { p: V[]; color: string };
const copy = [
  "ritween",
  "Ritween features, source to motion",
  "MAKE IDEAS MOVE.",
  "CODE-FIRST MOTION / WEBGPU",
  "Data with dimension.",
  "Charts that tell the story.",
  "BARS",
  "DONUT",
  "LINE",
  "SCATTER",
  "From values to visual rhythm.",
  "A little shape. A lot of character.",
  "3D, with an illustrated attitude.",
  "CEL SHADING",
  "INK OUTLINES",
  "TIMELINE ANIMATION",
  "Sound, from the source.",
  "Oscillators. Envelopes. Rhythm.",
  "SINE",
  "SAW",
  "PULSE",
  "SYNTHESIS → SOUNDTRACK",
  "Picture and sound. One timeline.",
  "Change your perspective.",
  "Orbit. Dolly. Boom.",
  "ORBIT",
  "DOLLY IN",
  "BOOM UP",
  "IMPACT",
  "Camera motion, choreographed in code.",
  "Built to keep moving.",
  "Source → GPU → frames → video",
  "SOURCE",
  "WEBGPU",
  "FRAMES",
  "MP4",
  "Evaluate the timeline",
  "Draw on the GPU",
  "Encode the frames",
  "A direct path from code to motion.",
  "Less time rendering.",
  "More time creating.",
  "MEDIAN EXPORT TIME / LOWER IS BETTER",
  "Ritween",
  "Other tool · prepared audio",
  "Other tool · audio + export",
  "41.791 s",
  "131.620 s",
  "149.479 s",
  "3.58×",
  "faster end-to-end in this test",
  "129.21",
  "effective export FPS",
  "Ritween includes audio synthesis during export.",
  "Supplied benchmark • Apple M1 / 16 GB • 90 s / 1080×1920 / 60 fps / 5,400 frames",
  "Median of 3 measured runs after 1 warm-up • Ritween 0.2.4 • Results vary by workload.",
  "ritween source to motion",
  "More frames. Less wait.",
  "IMAGINE. CODE. MOVE.",
  "01 / CHARTS",
  "02 / NPR ANIMATION",
  "03 / SOUND SYNTHESIS",
  "04 / CAMERA & IMPACT",
  "05 / RENDER PIPELINE",
  "06 / BENCHMARK",
  "0 s",
  "50",
  "100",
  "150 s",
  "WAVEFORM",
  "ENVELOPE",
  "OUTPUT",
  "41.03 FPS",
  "36.13 FPS",
];
export interface Drawing {
  atlas: Map<string, { w: number; size: number }>;
  circle: (
    x: number,
    y: number,
    r: number,
    col: string,
    alpha?: number,
    sy?: number,
  ) => void;
  ring: (
    x: number,
    y: number,
    r: number,
    col: string,
    w?: number,
    sy?: number,
    start?: number,
    end?: number,
  ) => void;
  mesh: (
    faces: Face[],
    cx: number,
    cy: number,
    scale: number,
    ry: number,
    rx?: number,
  ) => void;
  donut: Face[];
  ball: Face[];
  box: (
    w: number,
    h: number,
    d: number,
    color: string,
    x?: number,
    y?: number,
    z?: number,
  ) => Face[];
  logo: (x: number, y: number, size: number, alpha?: number) => void;
  text: (
    s: string,
    x: number,
    y: number,
    size?: number,
    col?: string,
    alpha?: number,
    align?: "left" | "center" | "right",
  ) => void;
  rect: (
    x: number,
    y: number,
    w: number,
    h: number,
    col: string,
    alpha?: number,
  ) => void;
  line: (
    x: number,
    y: number,
    X: number,
    Y: number,
    col?: string,
    w?: number,
    alpha?: number,
  ) => void;
  header: (k: string, title: string, sub: string, t: number) => void;
  path: (
    p: number[][],
    col?: string,
    w?: number,
    alpha?: number,
    closed?: boolean,
  ) => void;
  pill: (s: string, x: number, y: number, col?: string) => void;
  arrow: (
    x: number,
    y: number,
    X: number,
    Y: number,
    col?: string,
    w?: number,
  ) => void;
  poly: (p: number[][], col: string, alpha?: number) => void;
}

export function createScene(
  draw: (drawing: Drawing, time: number) => void,
): Scene {
  return createSceneTools(draw).scene!;
}

function createSceneTools(draw?: (drawing: Drawing, time: number) => void) {
  let device: GPUDevice,
    pipeline: GPURenderPipeline,
    buffer: GPUBuffer,
    texture: GPUTexture,
    bind: GPUBindGroup;
  const atlas = new Map<
    string,
    {
      x: number;
      y: number;
      w: number;
      h: number;
      size: number;
      inkX: number;
      inkY: number;
    }
  >();
  let vertices: number[] = [];
  const rgba = (hex: string, a = 1) => {
    const n = parseInt(hex.slice(1), 16);
    return [
      ((n >> 16) & 255) / 255,
      ((n >> 8) & 255) / 255,
      (n & 255) / 255,
      a,
    ];
  };
  function vertex(
    x: number,
    y: number,
    col: string,
    a = 1,
    u = 0,
    v = 0,
    tex = 0,
  ) {
    vertices.push(x / 960 - 1, 1 - y / 540, ...rgba(col, a), u, v, tex);
  }
  function tri(a: number[], b: number[], c: number[], col: string, alpha = 1) {
    for (const p of [a, b, c]) vertex(p[0], p[1], col, alpha);
  }
  function poly(p: number[][], col: string, alpha = 1) {
    for (let i = 1; i < p.length - 1; i++)
      tri(p[0], p[i], p[i + 1], col, alpha);
  }
  function line(
    x: number,
    y: number,
    X: number,
    Y: number,
    col = C.ink,
    w = 4,
    alpha = 1,
  ) {
    const d = Math.hypot(X - x, Y - y) || 1,
      nx = ((-(Y - y) / d) * w) / 2,
      ny = (((X - x) / d) * w) / 2;
    poly(
      [
        [x + nx, y + ny],
        [X + nx, Y + ny],
        [X - nx, Y - ny],
        [x - nx, y - ny],
      ],
      col,
      alpha,
    );
  }
  function path(p: number[][], col = C.ink, w = 4, alpha = 1, closed = false) {
    for (let i = 1; i < p.length; i++)
      line(
        ...(p[i - 1] as [number, number]),
        ...(p[i] as [number, number]),
        col,
        w,
        alpha,
      );
    if (closed)
      line(
        ...(p[p.length - 1] as [number, number]),
        ...(p[0] as [number, number]),
        col,
        w,
        alpha,
      );
  }
  function rect(
    x: number,
    y: number,
    w: number,
    h: number,
    col: string,
    alpha = 1,
  ) {
    poly(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      col,
      alpha,
    );
  }
  function circle(
    x: number,
    y: number,
    r: number,
    col: string,
    alpha = 1,
    sy = 1,
  ) {
    const p = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      p.push([x + Math.cos(a) * r, y + Math.sin(a) * r * sy]);
    }
    poly(p, col, alpha);
  }
  function ring(
    x: number,
    y: number,
    r: number,
    col: string,
    w = 4,
    sy = 1,
    start = 0,
    end = Math.PI * 2,
  ) {
    const p = [];
    for (let i = 0; i <= 96; i++) {
      const a = mix(start, end, i / 96);
      p.push([x + Math.cos(a) * r, y + Math.sin(a) * r * sy]);
    }
    path(p, col, w);
  }
  function text(
    s: string,
    x: number,
    y: number,
    size = 40,
    col = C.ink,
    alpha = 1,
    align: "left" | "center" | "right" = "left",
  ) {
    const q = atlas.get(s);
    if (!q) throw new Error("Missing text: " + s);
    const w = (q.w * size) / q.size,
      h = (q.h * size) / q.size;
    if (align === "center") x -= w / 2;
    if (align === "right") x -= w;
    const pts = [
      [x, y, q.x / 4096, q.y / 4096],
      [x + w, y, (q.x + q.w) / 4096, q.y / 4096],
      [x + w, y + h, (q.x + q.w) / 4096, (q.y + q.h) / 4096],
      [x, y + h, q.x / 4096, (q.y + q.h) / 4096],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = pts[i];
      vertex(p[0], p[1], col, alpha, p[2], p[3], 1);
    }
  }
  function pill(s: string, x: number, y: number, col = C.blue) {
    const q = atlas.get(s)!;
    const w = (q.w * 23) / q.size + 40;
    rect(x, y, w, 47, col);
    text(
      s,
      x + w / 2 - (q.inkX * 23) / q.size,
      y + 47 / 2 - (q.inkY * 23) / q.size,
      23,
      C.white,
    );
  }
  function logo(x: number, y: number, size: number, alpha = 1) {
    const u = 3840 / 4096,
      v = 3840 / 4096,
      U = 4095 / 4096,
      V = 4095 / 4096;
    const pts = [
      [x, y, u, v],
      [x + size, y, U, v],
      [x + size, y + size, U, V],
      [x, y + size, u, V],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = pts[i];
      vertex(p[0], p[1], C.white, alpha, p[2], p[3], 2);
    }
  }
  function header(k: string, title: string, sub: string, t: number) {
    const a = ease(t / 0.8);
    text(k, 100, 67, 23, C.blue, a);
    text(title, 96, 123 + 24 * (1 - a), 72, C.ink, a);
    text(sub, 100, 220, 31, C.muted, a);
  }
  function base(time: number) {
    rect(0, 0, 1920, 1080, C.paper);
    for (let i = 0; i < 20; i++) circle(100 + i * 90, 1015, 2, C.ink, 0.18);
    logo(100, 963, 38);
    text("ritween", 150, 967, 29);
    text("CODE-FIRST MOTION / WEBGPU", 1820, 976, 17, C.muted, 1, "right");
    rect(100, 1044, 1720, 3, C.ink, 0.12);
    rect(100, 1044, 1720 * clamp(time / 45), 3, C.blue);
  }
  function rot(p: V, ry: number, rx: number): V {
    let [x, y, z] = p;
    [x, z] = [
      x * Math.cos(ry) + z * Math.sin(ry),
      -x * Math.sin(ry) + z * Math.cos(ry),
    ];
    return [
      x,
      y * Math.cos(rx) - z * Math.sin(rx),
      y * Math.sin(rx) + z * Math.cos(rx),
    ];
  }
  function project(p: V, cx: number, cy: number, scale: number): number[] {
    const f = 8 / (8 - p[2]);
    return [cx + p[0] * scale * f, cy - p[1] * scale * f];
  }
  function mesh(
    faces: Face[],
    cx: number,
    cy: number,
    scale: number,
    ry: number,
    rx = -0.35,
  ) {
    const fs = faces
      .map((f) => ({ p: f.p.map((p) => rot(p, ry, rx)), color: f.color }))
      .sort(
        (a, b) =>
          a.p.reduce((s, p) => s + p[2], 0) / a.p.length -
          b.p.reduce((s, p) => s + p[2], 0) / b.p.length,
      );
    for (const f of fs) {
      const p = f.p.map((v) => project(v, cx, cy, scale));
      poly(p, f.color);
      path(p, C.ink, 3.5, 1, true);
    }
  }
  function box(
    w: number,
    h: number,
    d: number,
    color: string,
    x = 0,
    y = 0,
    z = 0,
  ): Face[] {
    const p: V[] = [
      [-w / 2, 0, -d / 2],
      [w / 2, 0, -d / 2],
      [w / 2, h, -d / 2],
      [-w / 2, h, -d / 2],
      [-w / 2, 0, d / 2],
      [w / 2, 0, d / 2],
      [w / 2, h, d / 2],
      [-w / 2, h, d / 2],
    ].map((p) => [p[0] + x, p[1] + y, p[2] + z] as V);
    return [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [1, 5, 6, 2],
      [3, 2, 6, 7],
      [0, 1, 5, 4],
    ].map((ids, i) => ({
      p: ids.map((i) => p[i]),
      color: i === 4 ? C.lime : i === 2 ? C.blue : color,
    }));
  }
  function torus(r: number, tube: number, color: string): Face[] {
    const faces: Face[] = [];
    const pt = (i: number, j: number): V => {
      const a = (i / 40) * Math.PI * 2,
        b = (j / 8) * Math.PI * 2;
      return [
        (r + tube * Math.cos(b)) * Math.cos(a),
        tube * Math.sin(b),
        (r + tube * Math.cos(b)) * Math.sin(a),
      ];
    };
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 8; j++)
        faces.push({
          p: [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)],
          color: j < 3 ? C.lime : j < 5 ? color : C.blue,
        });
    return faces;
  }
  function sphere(): Face[] {
    const f: Face[] = [];
    const pt = (i: number, j: number): V => {
      const a = (i / 16) * Math.PI * 2,
        b = (j / 10) * Math.PI;
      return [
        Math.sin(b) * Math.cos(a),
        Math.cos(b),
        Math.sin(b) * Math.sin(a),
      ];
    };
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 10; j++)
        f.push({
          p: [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)],
          color:
            j < 3 ? C.lime : i % 4 === 0 ? C.blue : j < 7 ? C.coral : C.blue,
        });
    return f;
  }
  const ball = sphere(),
    donut = torus(1, 0.34, C.coral);
  function arrow(
    x: number,
    y: number,
    X: number,
    Y: number,
    col = C.ink,
    w = 4,
  ) {
    line(x, y, X, Y, col, w);
    const a = Math.atan2(Y - y, X - x);
    line(X, Y, X - 16 * Math.cos(a - 0.5), Y - 16 * Math.sin(a - 0.5), col, w);
    line(X, Y, X - 16 * Math.cos(a + 0.5), Y - 16 * Math.sin(a + 0.5), col, w);
  }
  const tools = {
    atlas,
    circle,
    ring,
    mesh,
    donut,
    box,
    ball,
    logo,
    text,
    rect,
    line,
    header,
    path,
    pill,
    arrow,
    poly,
  };
  const scene: Scene = {
    async setup(ctx) {
      device = ctx.device;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 4096;
      const c = canvas.getContext("2d")!;
      let x = 4,
        y = 4,
        row = 0;
      await document.fonts.ready;
      for (const s of copy) {
        const size = s === "ritween" ? 190 : 64;
        c.font = `${s === "ritween" ? 800 : 600} ${size}px Arial, sans-serif`;
        const w = Math.ceil(c.measureText(s).width) + 8,
          h = Math.ceil(size * 1.3);
        if (x + w > 4096) {
          x = 4;
          y += row + 4;
          row = 0;
        }
        if (y + h > 4096) throw new Error("Text atlas overflow");
        c.fillStyle = "white";
        c.textBaseline = "top";
        c.fillText(s, x + 3, y + 3);
        const m = c.measureText(s);
        atlas.set(s, {
          x,
          y,
          w,
          h,
          size,
          inkX: 3 + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2,
          inkY:
            3 + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2,
        });
        x += w + 4;
        row = Math.max(row, h);
      }
      const logoImage = new Image();
      logoImage.src = new URL(
        "../assets/ritween-logo.svg",
        import.meta.url,
      ).href;
      await logoImage.decode();
      c.drawImage(logoImage, 3840, 3840, 255, 255);
      texture = device.createTexture({
        size: [4096, 4096],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: canvas },
        { texture },
        [4096, 4096],
      );
      const shader = device.createShaderModule({
        code: `struct Out {@builtin(position) pos:vec4f,@location(0) color:vec4f,@location(1) uv:vec2f,@location(2) tex:f32}; @vertex fn vs(@location(0) pos:vec2f,@location(1) color:vec4f,@location(2) uv:vec2f,@location(3) tex:f32)->Out {var o:Out;o.pos=vec4f(pos,0,1);o.color=color;o.uv=uv;o.tex=tex;return o;} @group(0) @binding(0) var img:texture_2d<f32>; @group(0) @binding(1) var samp:sampler; @fragment fn fs(i:Out)->@location(0) vec4f {let sample=textureSample(img,samp,i.uv);let a=mix(1.,sample.a,min(i.tex,1.));let rgb=mix(i.color.rgb,sample.rgb,step(1.5,i.tex));return vec4f(rgb,i.color.a*a);}`,
      });
      const info = await shader.getCompilationInfo();
      for (const m of info.messages)
        if (m.type === "error") throw new Error(m.message);
      pipeline = await device.createRenderPipelineAsync({
        layout: "auto",
        vertex: {
          module: shader,
          entryPoint: "vs",
          buffers: [
            {
              arrayStride: 36,
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x2" },
                { shaderLocation: 1, offset: 8, format: "float32x4" },
                { shaderLocation: 2, offset: 24, format: "float32x2" },
                { shaderLocation: 3, offset: 32, format: "float32" },
              ],
            },
          ],
        },
        fragment: {
          module: shader,
          entryPoint: "fs",
          targets: [
            {
              format: ctx.format,
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
      buffer = device.createBuffer({
        size: 16 * 1024 * 1024,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          {
            binding: 1,
            resource: device.createSampler({
              magFilter: "linear",
              minFilter: "linear",
            }),
          },
        ],
      });
    },
    render({ time, localTime, encoder, target }) {
      vertices = [];
      base(time);
      draw!(tools, localTime);
      const data = new Float32Array(vertices);
      if (data.byteLength > buffer.size)
        throw new Error("Vertex buffer overflow");
      device.queue.writeBuffer(buffer, 0, data);
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: { r: 1, g: 1, b: 1, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.setVertexBuffer(0, buffer);
      pass.draw(vertices.length / 9);
      pass.end();
    },
    dispose() {
      buffer?.destroy();
      texture?.destroy();
    },
  };
  return { ...tools, scene };
}
