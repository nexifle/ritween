import type { Scene } from "ritween";

// Pixel-space geometry, converted to clip space on the CPU. No frame-to-frame state.
type Color = readonly [number, number, number, number];
type Point = readonly [number, number];
const ink: Color = [0.17, 0.22, 0.23, 1];
const slate: Color = [0.38, 0.47, 0.48, 1];
const ochre: Color = [0.66, 0.43, 0.24, 1];
const colors = [ink, slate, ochre];
const squareSize = 28;
const travelStart = 0.15;
const travelEnd = 2.4;
const assemblyStart = 1.85;
const assemblyEnd = 3.4;
const handoffStart = 2.85;
const handoffEnd = 5.2;
const handoffDistance = 96;
const routes: readonly (readonly [Point, Point, Point, Point])[] = [
  [
    [84, 210],
    [130, 155],
    [242, 143],
    [300, 165],
  ],
  [
    [181, 260],
    [208, 209],
    [240, 222],
    [267, 219],
  ],
  [
    [555, 161],
    [480, 218],
    [401, 205],
    [353, 172],
  ],
];
// A triangular group keeps each square distinct, with eight-pixel gaps.
const groupCenters: readonly Point[] = [
  [320, 180],
  [302, 216],
  [338, 216],
];

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => {
  const x = clamp(n);
  return x ** 3 * (x * (6 * x - 15) + 10);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function cubic(
  [a, b, c, d]: readonly [Point, Point, Point, Point],
  t: number,
): Point {
  const q = 1 - t;
  return [
    q ** 3 * a[0] +
      3 * q ** 2 * t * b[0] +
      3 * q * t ** 2 * c[0] +
      t ** 3 * d[0],
    q ** 3 * a[1] +
      3 * q ** 2 * t * b[1] +
      3 * q * t ** 2 * c[1] +
      t ** 3 * d[1],
  ];
}

// Precompute distance along each curve so easing controls distance, not Bezier parameter speed.
const routeLengths = routes.map((route) => {
  const lengths = [0];
  let previous = cubic(route, 0);
  for (let i = 1; i <= 128; i++) {
    const point = cubic(route, i / 128);
    lengths.push(
      lengths[i - 1] +
        Math.hypot(point[0] - previous[0], point[1] - previous[1]),
    );
    previous = point;
  }
  return lengths;
});
function routeParameter(index: number, distance: number): number {
  const lengths = routeLengths[index];
  const target = clamp(distance) * lengths[128];
  let low = 0;
  let high = 128;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (lengths[middle] < target) low = middle;
    else high = middle;
  }
  return (low + (target - lengths[low]) / (lengths[high] - lengths[low])) / 128;
}

// Overlap travel, gathering and group translation instead of braking between beats.
export function squareCentersAt(localTime: number): readonly Point[] {
  const travel = ease((localTime - travelStart) / (travelEnd - travelStart));
  const assembly = ease(
    (localTime - assemblyStart) / (assemblyEnd - assemblyStart),
  );
  const handoff = ease(
    (localTime - handoffStart) / (handoffEnd - handoffStart),
  );
  return routes.map((route, index): Point => {
    const t = routeParameter(index, travel);
    const [pathX, pathY] = cubic(route, t);
    const [groupX, groupY] = groupCenters[index];
    return [
      pathX +
        ((groupX - route[3][0]) * assembly + handoffDistance * handoff) *
          t ** 3,
      pathY + (groupY - route[3][1]) * assembly * t ** 3,
    ];
  });
}

const shader = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};
struct Input {
  @location(0) position: vec2f,
  @location(1) color: vec4f,
};
@vertex fn geometry(input: Input) -> VertexOut {
  var output: VertexOut;
  output.position = vec4f(input.position, 0.0, 1.0);
  output.uv = vec2f(0.0);
  output.color = input.color;
  return output;
}
@fragment fn solid(input: VertexOut) -> @location(0) vec4f { return input.color; }
@group(0) @binding(0) var textSampler: sampler;
@group(0) @binding(1) var textTexture: texture_2d<f32>;
@vertex fn fullscreen(@builtin(vertex_index) index: u32) -> VertexOut {
  let p = array<vec2f, 6>(
    vec2f(-1.0, 1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(1.0, -1.0)
  );
  var output: VertexOut;
  output.position = vec4f(p[index], 0.0, 1.0);
  output.uv = vec2f((p[index].x + 1.0) * 0.5, (1.0 - p[index].y) * 0.5);
  output.color = vec4f(1.0);
  return output;
}
@fragment fn lettering(input: VertexOut) -> @location(0) vec4f {
  return textureSample(textTexture, textSampler, input.uv);
}
`;

export default function motionStudy(): Scene {
  let vertices: GPUBuffer | undefined;
  let lettering: GPUTexture | undefined;
  let multisampled: GPUTexture | undefined;
  let geometryPipeline: GPURenderPipeline;
  let textPipeline: GPURenderPipeline;
  let textBind: GPUBindGroup;
  return {
    async setup({ device, format }) {
      // A system font needs no download, but wait if the host has registered fonts.
      await document.fonts.ready;
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error("Canvas text is unavailable");
      ctx.fillStyle = "#283537";
      ctx.font = "600 14px Arial, sans-serif";
      ctx.fillText("MOTION / STUDY", 36, 46);
      ctx.font = "600 28px Arial, sans-serif";
      ctx.fillText("From motion to form", 36, 86);
      ctx.font = "16px Arial, sans-serif";
      ctx.fillStyle = "#465557";
      ctx.fillText("Three paths. One system.", 37, 112);
      ctx.font = "13px Arial, sans-serif";
      ctx.fillText("PATHS   /   ASSEMBLY   /   HANDOFF", 36, 323);
      ctx.fillText("06 SEC", 548, 323);

      lettering = device.createTexture({
        size: [640, 360],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: canvas },
        { texture: lettering, premultipliedAlpha: false },
        [640, 360],
      );
      vertices = device.createBuffer({
        size: 131072,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const module = device.createShaderModule({ code: shader });
      const blend: GPUBlendState = {
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
      };
      geometryPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "geometry",
          buffers: [
            {
              arrayStride: 24,
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x2" },
                { shaderLocation: 1, offset: 8, format: "float32x4" },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: "solid", targets: [{ format, blend }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: 4 },
      });
      textPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "fullscreen" },
        fragment: {
          module,
          entryPoint: "lettering",
          targets: [{ format, blend }],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: 4 },
      });
      textBind = device.createBindGroup({
        layout: textPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: device.createSampler({
              magFilter: "linear",
              minFilter: "linear",
            }),
          },
          { binding: 1, resource: lettering.createView() },
        ],
      });
    },
    render({ device, encoder, target, localTime }) {
      const data: number[] = [];
      const vertex = (x: number, y: number, color: Color) => {
        data.push(x / 320 - 1, 1 - y / 180, ...color);
      };
      const rect = (
        x: number,
        y: number,
        w: number,
        h: number,
        color: Color,
      ) => {
        vertex(x, y, color);
        vertex(x + w, y, color);
        vertex(x, y + h, color);
        vertex(x, y + h, color);
        vertex(x + w, y, color);
        vertex(x + w, y + h, color);
      };
      const segment = (a: Point, b: Point, width: number, color: Color) => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length = Math.hypot(dx, dy) || 1;
        const nx = (-dy * width) / (2 * length);
        const ny = (dx * width) / (2 * length);
        vertex(a[0] + nx, a[1] + ny, color);
        vertex(b[0] + nx, b[1] + ny, color);
        vertex(a[0] - nx, a[1] - ny, color);
        vertex(a[0] - nx, a[1] - ny, color);
        vertex(b[0] + nx, b[1] + ny, color);
        vertex(b[0] - nx, b[1] - ny, color);
      };
      const centers = squareCentersAt(localTime);
      const assembly = ease(
        (localTime - assemblyStart) / (assemblyEnd - assemblyStart),
      );
      const travel = ease(
        (localTime - travelStart) / (travelEnd - travelStart),
      );
      const handoff = ease(
        (localTime - handoffStart) / (handoffEnd - handoffStart),
      );
      routes.forEach((route, index) => {
        const color = colors[index];
        const end = route[3];
        const center: Point = [
          mix(end[0], groupCenters[index][0], assembly) +
            handoffDistance * handoff,
          mix(end[1], groupCenters[index][1], assembly),
        ];
        // Move the curve's endpoint with its square during assembly and handoff.
        const pointAt = (t: number): Point => {
          const [x, y] = cubic(route, t);
          return [
            x + (center[0] - end[0]) * t ** 3,
            y + (center[1] - end[1]) * t ** 3,
          ];
        };
        const pathEnd = routeParameter(index, travel);
        const pathStart = 0.3 * handoff;
        const curve = pointAt;
        for (let i = 0; i < 64; i++) {
          const a = mix(pathStart, 1, i / 64);
          const b = mix(pathStart, 1, (i + 1) / 64);
          // The light full route establishes direction; the inked portion records travel.
          const guide: Color = [color[0], color[1], color[2], 0.16];
          const trail: Color = [color[0], color[1], color[2], 0.58];
          segment(curve(a), curve(b), 1.4, guide);
          if (a < pathEnd) {
            segment(curve(a), curve(Math.min(b, pathEnd)), 2.2, trail);
          }
        }
      });
      centers.forEach(([x, y], index) => {
        rect(
          x - squareSize / 2,
          y - squareSize / 2,
          squareSize,
          squareSize,
          colors[index],
        );
      });
      const bytes = new Float32Array(data);
      if (!vertices || bytes.byteLength > vertices.size)
        throw Error("Geometry buffer exceeded");
      device.queue.writeBuffer(vertices, 0, bytes);
      if (
        !multisampled ||
        multisampled.width !== target.width ||
        multisampled.height !== target.height
      ) {
        multisampled?.destroy();
        multisampled = device.createTexture({
          size: [target.width, target.height],
          format: target.format,
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: multisampled.createView(),
            resolveTarget: target.createView(),
            clearValue: { r: 0.935, g: 0.928, b: 0.899, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(geometryPipeline);
      pass.setVertexBuffer(0, vertices);
      pass.draw(data.length / 6);
      pass.setPipeline(textPipeline);
      pass.setBindGroup(0, textBind);
      pass.draw(6);
      pass.end();
    },
    dispose() {
      vertices?.destroy();
      lettering?.destroy();
      multisampled?.destroy();
    },
  };
}
