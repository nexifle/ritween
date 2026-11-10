/**
 * G0/G7 layout baseline harness (docs/plans/declarative-layout-hardening.md §5.7–5.8, §13).
 *
 * Runs inside a browser page (served by scripts/layout-baseline-run.mjs through
 * Vite). Metrics, with explicit availability labels:
 * - endToEndMs: actual production FrameSource.create + render (renderAsync +
 *   queue.onSubmittedWorkDone inside FrameSource) — the only "total frame"
 *   metric, matching the offline CLI route.
 * - layoutCpuMicrobenchmark: separate evaluateView CPU microbenchmark with a
 *   delegating wrapper around production ViewRenderer.measureText, using the
 *   same fixture font as the frames. Canvas2D measurement needs no GPU setup,
 *   so this never touches a device (the frame device is already disposed).
 *   Explicitly NOT a frame phase and never added to endToEndMs.
 * - measureCalls at frame level: UNAVAILABLE. Stage's measurer is an instance
 *   field on its own ViewRenderer. canvas2dMeasureText counts every
 *   CanvasRenderingContext2D.measureText call during FrameSource.render,
 *   including rasterization, and is not that metric. A root-canvas filter is
 *   UNAVAILABLE: measurement and raster share one canvas, with no exact seam.
 *   Text reuse stays UNAVAILABLE. The microbenchmark carries its own counts.
 * - frameTiming names the instrumented or uninstrumented distribution.
 *   Instrumented endToEndMs includes wrapper overhead and is not comparable
 *   to the frozen uninstrumented baseline, not a performance improvement,
 *   and not a G7 pass. G7 remains incomplete.
 * - gpu.beginRenderPasses: counted by proxying the command encoder handed to
 *   scene render (benchmark-only proxy; production objects untouched). The
 *   device wrapper stays installed for creation, every measured frame, capture
 *   and disposal, and is restored in finally; a zero pass count throws.
 * - gpu metrics: beginRenderPasses counted per measured frame; render-target
 *   creations split into measured-phase and capture-phase deltas. Per-path
 *   texture reuse is UNAVAILABLE (the surface cache is internal to
 *   ViewRenderer); creation deltas are never labeled reuse.
 * - inspectMs: StageScene.inspect() (last rendered frame) only. The G1 CLI
 *   inspection does not exist yet; its cost is reported as unavailable.
 * - pixelProof: selected frames captured as PNG; A→B→A repeats calibrate
 *   determinism of the controlled environment.
 */
import {
  loadFixtureFont,
  fixtureFontFamily,
} from "../tests/fixtures/baseline-font";
import {
  evaluateRegression,
  evaluateStress,
  fixtureTheme,
  countLayoutNodes,
  stressExpectedLayoutNodeCount,
} from "../tests/fixtures/layout-regression";
import type { MeasureText } from "../src/authoring/layout";

export interface HarnessRunOptions {
  fixture: "regression" | "stress";
  warmup: number;
  measured: number;
  /** Frame clock (seconds) used for every measured frame after warmup. */
  frameTime?: number;
  /** Project-time samples for pixel proof; A→B→A order included. */
  pixelStates?: readonly number[];
  /**
   * Benchmark-only Canvas 2D measureText probe, installed before
   * FrameSource.create and restored in finally. Default off. Only an explicit
   * true installs it. Omitted and false keep the uninstrumented timing
   * distribution and do not invent zero call counts.
   */
  canvas2dProbe?: boolean;
}

/** Probe stays off unless the caller opts in. Baseline run and replay omit this. */
export function canvas2dProbeEnabled(
  options: Pick<HarnessRunOptions, "canvas2dProbe">,
): boolean {
  return options.canvas2dProbe === true;
}

export interface HarnessRunResult {
  fixture: string;
  fontProof: Awaited<ReturnType<typeof loadFixtureFont>>;
  warmup: number;
  measured: number;
  /** Production FrameSource.render through GPU completion. */
  endToEndMs: { median: number; p95: number };
  /** evaluateView microbenchmark; explicitly not a frame phase. */
  layoutCpuMicrobenchmark: LayoutCpuMicrobenchmark;
  measureCalls:
    { available: true; count: number } | { available: false; reason: string };
  /**
   * Canvas 2D measureText during FrameSource.create and each
   * FrameSource.render. Not ViewRenderer.measureText.
   */
  canvas2dMeasureText:
    Canvas2dMeasureTextReport | Canvas2dMeasureTextUnavailable;
  /** Which timing distribution endToEndMs belongs to. Not a G7 gate. */
  frameTiming: FrameTimingDistribution;
  /** This harness unit does not close G7. */
  g7: { complete: false };
  /** Decoded-RGBA A→B→A calibration verdict for this run. */
  pixelProof: PixelProof;
  gpu: {
    beginRenderPasses: { median: number; p95: number };
    renderTargetTexturesCreated: number;
    otherTexturesCreated: number;
    /** Creation delta over measured frames only. */
    measuredPhaseRenderTargetCreations: number;
    /** Creation delta over pixel-capture frames only. */
    capturePhaseRenderTargetCreations: number;
    texturesReused:
      { available: true; count: number } | { available: false; reason: string };
    availability: "measured";
  };
  tree: {
    layoutNodes: number;
    drawCommands: number;
    textRuns: number;
    distinctTexts: number;
    width: number;
    height: number;
  };
  inspect: { available: true; ms: number } | { available: false };
  /** The CLI exists (G1b); its cost is not measured inside this page harness. */
  inspectionCli: { available: false; reason: string };
  fixtureCounts: {
    expectedLayoutNodes: number | null;
    actualLayoutNodes: number;
  };
}

export interface Statistics {
  median: number;
  p95: number;
}

/**
 * Conventional median (the mean of the two middle values for an even count) over
 * a copied, sorted sample; p95 stays nearest-rank as the gate requires. With the
 * 300-frame default an even count is the norm, so a nearest-rank median would
 * report the lower middle sample instead of the median.
 */
export function summarize(values: readonly number[]): Statistics {
  if (!values.length) throw Error("Cannot summarize an empty sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = Number.isInteger(middle)
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
  const p95 =
    sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { median, p95 };
}

export function validateRunOptions(options: HarnessRunOptions): void {
  if (options.fixture !== "regression" && options.fixture !== "stress")
    throw Error(`Unknown fixture: ${String(options.fixture)}`);
  if (!Number.isInteger(options.warmup) || options.warmup < 0)
    throw Error("warmup must be a non-negative integer.");
  if (!Number.isInteger(options.measured) || options.measured < 1)
    throw Error("measured must be a positive integer.");
  if (
    options.frameTime !== undefined &&
    (!Number.isFinite(options.frameTime) || options.frameTime < 0)
  )
    throw Error("frameTime must be a finite non-negative number.");
}

export interface GpuCounters {
  beginRenderPasses: number;
  renderTargetTexturesCreated: number;
  otherTexturesCreated: number;
}

/** A captured property so restore returns the exact own/inherited state. */
export interface CapturedProperty {
  target: object;
  key: string;
  descriptor: PropertyDescriptor | undefined;
}

export function captureProperty(target: object, key: string): CapturedProperty {
  return {
    target,
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key),
  };
}

/** Restores an own descriptor, or removes an own property that shadowed an
 * inherited one. Assigning the native method instead would leave it own. */
export function restoreProperty(captured: CapturedProperty): void {
  if (captured.descriptor)
    Object.defineProperty(captured.target, captured.key, captured.descriptor);
  else Reflect.deleteProperty(captured.target, captured.key);
}

export const CANVAS2D_MEASURE_TEXT_SEMANTICS =
  "CanvasRenderingContext2D.measureText calls during the named interval, including text rasterization. Not a ViewRenderer.measureText count.";

export const RASTER_MG_SEMANTICS =
  'Calls whose first argument is exactly "Mg". Diagnostic only: layout text can also be "Mg", so this is not a rasterization count.';

const LAYOUT_MEASURER_UNAVAILABLE = {
  available: false as const,
  reason:
    "ViewRenderer.measureText is an instance field on Stage's internal renderer. Canvas 2D totals include rasterization and are not this count.",
};

const ROOT_CANVAS_UNAVAILABLE = {
  available: false as const,
  reason:
    "No exact canvas seam separates measurement from rasterization: each ViewRenderer uses one canvas for both measureText and rasterText. A filtered root-canvas count is not reported.",
};

const TEXT_REUSE_UNAVAILABLE = {
  available: false as const,
  reason:
    "Text and surface reuse per path is internal to ViewRenderer. Creation deltas are not reuse, and a zero is not reported.",
};

export interface UnavailableMetric {
  available: false;
  reason: string;
}

/** One observed Canvas 2D measureText interval. Zero is an observation. */
export interface Canvas2dFrameCount {
  canvas2dMeasureTextCalls: number;
  /** Diagnostic only. Not a rasterization count. */
  rasterMgCalls: number;
}

export interface Canvas2dPhase {
  frames: number;
  /** Raw per-frame counts. Not mixed with warmup, capture, or the microbenchmark. */
  perFrame: Canvas2dFrameCount[];
  totalCanvas2dMeasureTextCalls: number;
  totalRasterMgCalls: number;
  callsSummary: Statistics & { available: true };
}

export interface Canvas2dMeasureTextReport {
  available: true;
  semantics: typeof CANVAS2D_MEASURE_TEXT_SEMANTICS;
  rasterMgSemantics: typeof RASTER_MG_SEMANTICS;
  setup: Canvas2dFrameCount;
  warmup: Canvas2dPhase | UnavailableMetric;
  measured: Canvas2dPhase;
  capture: Canvas2dPhase | UnavailableMetric;
  layoutMeasurerCalls: UnavailableMetric;
  rootMeasurementCanvasCalls: UnavailableMetric;
  textReuse: UnavailableMetric;
}

export interface Canvas2dMeasureTextUnavailable extends UnavailableMetric {
  layoutMeasurerCalls: UnavailableMetric;
  rootMeasurementCanvasCalls: UnavailableMetric;
  textReuse: UnavailableMetric;
}

export interface FrameTimingDistribution {
  distribution: "instrumented-canvas2d-measureText-wrapper" | "uninstrumented";
  comparableToFrozenUninstrumentedBaseline: boolean;
  performanceGate: "not-applicable";
  reason: string;
}

export interface Canvas2dMeasureTextProbe {
  snapshot(): Canvas2dFrameCount;
  reset(): void;
  /** Returns the count since the last reset or take, then resets. */
  take(): Canvas2dFrameCount;
  restore(): void;
}

let activeCanvas2dProbe: Canvas2dMeasureTextProbe | undefined;

function canvas2dPrototype(): object {
  const ctor = (
    globalThis as { CanvasRenderingContext2D?: { prototype: object } }
  ).CanvasRenderingContext2D;
  if (!ctor) throw Error("CanvasRenderingContext2D is unavailable.");
  return ctor.prototype;
}

/**
 * Benchmark-only wrapper around CanvasRenderingContext2D.prototype.measureText.
 * Forwards the receiver, arguments, return value, and exception. A second
 * install is rejected so probes cannot nest.
 */
export function installCanvas2dMeasureTextProbe(
  target: object = canvas2dPrototype(),
): Canvas2dMeasureTextProbe {
  if (activeCanvas2dProbe)
    throw Error(
      "Canvas 2D measureText probe is already installed. Concurrent probes and nested wrappers are rejected.",
    );
  const captured = captureProperty(target, "measureText");
  const native = (captured.descriptor?.value ??
    Reflect.get(target, "measureText")) as unknown;
  if (typeof native !== "function")
    throw Error(
      "CanvasRenderingContext2D.prototype.measureText is not a function.",
    );
  const observed = { canvas2dMeasureTextCalls: 0, rasterMgCalls: 0 };
  const wrapped = function measureText(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    observed.canvas2dMeasureTextCalls += 1;
    if (args[0] === "Mg") observed.rasterMgCalls += 1;
    return Reflect.apply(native, this, args);
  };
  let restored = false;
  const probe: Canvas2dMeasureTextProbe = {
    snapshot: () => ({ ...observed }),
    reset() {
      observed.canvas2dMeasureTextCalls = 0;
      observed.rasterMgCalls = 0;
    },
    take() {
      const snap = probe.snapshot();
      probe.reset();
      return snap;
    },
    restore() {
      if (restored) return;
      restoreProperty(captured);
      restored = true;
      if (activeCanvas2dProbe === probe) activeCanvas2dProbe = undefined;
    },
  };
  Object.defineProperty(target, "measureText", {
    configurable: true,
    enumerable: captured.descriptor?.enumerable ?? false,
    writable: true,
    value: wrapped,
  });
  activeCanvas2dProbe = probe;
  return probe;
}

function canvas2dPhase(
  perFrame: readonly Canvas2dFrameCount[],
): Canvas2dPhase | UnavailableMetric {
  if (!perFrame.length)
    return {
      available: false,
      reason: "no frames in this phase; call count is not zero",
    };
  return {
    frames: perFrame.length,
    perFrame: perFrame.map((frame) => ({ ...frame })),
    totalCanvas2dMeasureTextCalls: perFrame.reduce(
      (sum, frame) => sum + frame.canvas2dMeasureTextCalls,
      0,
    ),
    totalRasterMgCalls: perFrame.reduce(
      (sum, frame) => sum + frame.rasterMgCalls,
      0,
    ),
    callsSummary: {
      available: true,
      ...summarize(perFrame.map((frame) => frame.canvas2dMeasureTextCalls)),
    },
  };
}

export function assembleCanvas2dReport(phases: {
  setup: Canvas2dFrameCount;
  warmup: readonly Canvas2dFrameCount[];
  measured: readonly Canvas2dFrameCount[];
  capture: readonly Canvas2dFrameCount[];
}): Canvas2dMeasureTextReport {
  const measured = canvas2dPhase(phases.measured);
  if (!("frames" in measured))
    throw Error("Measured phase has no frames; call count is not zero.");
  return {
    available: true,
    semantics: CANVAS2D_MEASURE_TEXT_SEMANTICS,
    rasterMgSemantics: RASTER_MG_SEMANTICS,
    setup: { ...phases.setup },
    warmup: canvas2dPhase(phases.warmup),
    measured,
    capture: canvas2dPhase(phases.capture),
    layoutMeasurerCalls: LAYOUT_MEASURER_UNAVAILABLE,
    rootMeasurementCanvasCalls: ROOT_CANVAS_UNAVAILABLE,
    textReuse: TEXT_REUSE_UNAVAILABLE,
  };
}

export function unavailableCanvas2dMeasureText(): Canvas2dMeasureTextUnavailable {
  return {
    available: false,
    reason:
      "Canvas 2D measureText probe was not installed. Call counts are not reported as zero.",
    layoutMeasurerCalls: LAYOUT_MEASURER_UNAVAILABLE,
    rootMeasurementCanvasCalls: ROOT_CANVAS_UNAVAILABLE,
    textReuse: TEXT_REUSE_UNAVAILABLE,
  };
}

export function frameTimingDistribution(
  instrumented: boolean,
): FrameTimingDistribution {
  if (instrumented)
    return {
      distribution: "instrumented-canvas2d-measureText-wrapper",
      comparableToFrozenUninstrumentedBaseline: false,
      performanceGate: "not-applicable",
      reason:
        "endToEndMs and the layout CPU microbenchmark include Canvas 2D measureText wrapper overhead. Do not compare this distribution to the frozen uninstrumented baseline, and do not read a delta as a performance improvement or a passing G7 gate.",
    };
  return {
    distribution: "uninstrumented",
    comparableToFrozenUninstrumentedBaseline: true,
    performanceGate: "not-applicable",
    reason:
      "No Canvas 2D measureText wrapper. This is the uninstrumented distribution, not a G7 gate and not a performance improvement claim. Frozen baseline artifacts were not modified.",
  };
}

// RENDER_ATTACHMENT flag bit; defined in the browser, constant in Node tests.
const RENDER_ATTACHMENT =
  typeof GPUTextureUsage !== "undefined"
    ? GPUTextureUsage.RENDER_ATTACHMENT
    : 0x10;

/**
 * Benchmark-only device proxy. Native method receivers are preserved with
 * bound functions; only createTexture (usage classification) and
 * createCommandEncoder (recursive pass-counting proxy) are wrapped. All other
 * members forward untouched so production behavior and ordering are identical.
 */
export function instrumentDevice(
  device: GPUDevice,
  counters: GpuCounters,
): GPUDevice {
  const instrumentEncoder = (encoder: GPUCommandEncoder): GPUCommandEncoder =>
    new Proxy(encoder, {
      get(target, property) {
        if (property === "beginRenderPass") {
          const begin = target.beginRenderPass.bind(target);
          return (
            ...args: Parameters<GPUCommandEncoder["beginRenderPass"]>
          ) => {
            counters.beginRenderPasses++;
            return begin(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as GPUCommandEncoder;
  // Wrap on the real device: GPUDevice brand checks (context.configure)
  // reject proxies, so the instrumented "device" IS the real object with two
  // benchmark-only method replacements. Every other member is untouched and
  // identity is preserved for production code paths.
  const createTexture = device.createTexture.bind(device);
  device.createTexture = ((...args: Parameters<GPUDevice["createTexture"]>) => {
    const texture = createTexture(...args);
    if (args[0]?.usage & RENDER_ATTACHMENT)
      counters.renderTargetTexturesCreated++;
    else counters.otherTexturesCreated++;
    return texture;
  }) as GPUDevice["createTexture"];
  const createCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = ((
    ...args: Parameters<GPUDevice["createCommandEncoder"]>
  ) =>
    instrumentEncoder(
      createCommandEncoder(...args),
    )) as GPUDevice["createCommandEncoder"];
  return device;
}

/**
 * Installs the benchmark-only device wrapper for a WHOLE run and returns the
 * restore function. FrameSource.create requests its own device, so navigator.gpu
 * is shimmed to hand out this instrumented real device. The wrapper must stay
 * installed through creation, every measured frame, capture and disposal, or
 * the recorded pass/creation counts silently drop to zero.
 */
export function installDeviceInstrumentation(
  device: GPUDevice,
  counters: GpuCounters,
): () => void {
  const captured = [
    captureProperty(device, "createTexture"),
    captureProperty(device, "createCommandEncoder"),
    captureProperty(navigator, "gpu"),
  ];
  instrumentDevice(device, counters);
  const nativeGpu = navigator.gpu;
  Object.defineProperty(navigator, "gpu", {
    configurable: true,
    value: {
      getPreferredCanvasFormat: () => nativeGpu.getPreferredCanvasFormat(),
      requestAdapter: async () => ({ requestDevice: async () => device }),
    },
  });
  return () => {
    for (const entry of captured) restoreProperty(entry);
  };
}

/** Blob bodies cannot cross the Playwright serialization boundary. */
async function b64encode(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface PixelProof {
  tolerance: string;
  repeatIdentical: boolean;
  repeatDifferingBytes: number;
  aVsBDifferingBytes: number;
  aVsBDiffer: boolean;
}

/**
 * Calibration contract: repeated state A must decode to identical RGBA bytes,
 * and state contrast must match the fixture's design — the regression fixture
 * animates (A and B must differ), the stress fixture is static by construction
 * (A and B must be identical, which is an expectation, not a weak pass).
 */
export function assertPixelCalibration(
  fixture: "regression" | "stress",
  proof: Pick<
    PixelProof,
    | "repeatIdentical"
    | "repeatDifferingBytes"
    | "aVsBDiffer"
    | "aVsBDifferingBytes"
  >,
): void {
  if (!proof.repeatIdentical)
    throw Error(
      `Pixel calibration failed: repeated state A differs from itself by ${proof.repeatDifferingBytes} decoded RGBA bytes; this environment is not deterministic.`,
    );
  const expectMotion = fixture === "regression";
  if (proof.aVsBDiffer !== expectMotion)
    throw Error(
      expectMotion
        ? "Pixel calibration failed: regression states A and B render identical pixels; no motion was captured."
        : "Pixel calibration failed: the static stress fixture changed between states A and B.",
    );
}

export interface LayoutCpuMicrobenchmark {
  /** evaluateView CPU time including the injected measurer; NOT a frame phase. */
  medianMs: number;
  p95Ms: number;
  runs: number;
  /** Measurer calls made by this microbenchmark only; zero is a harness bug. */
  measureCalls: number;
}

/**
 * CPU-only microbenchmark of evaluateView with the production measurer path
 * (ViewRenderer.measureText). Explicitly labeled: this is not Stage frame
 * timing and must never be reported as a frame phase.
 */
export function benchmarkLayoutCpu(
  fixture: "regression" | "stress",
  time: number,
  measurer: MeasurerState,
  runs = 30,
): LayoutCpuMicrobenchmark {
  const callsBefore = measurer.state.count;
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    if (fixture === "stress")
      evaluateStress(time, {
        measureText: measurer.measureText,
        font: fixtureFontFamily,
      });
    else
      evaluateRegression(time, {
        measureText: measurer.measureText,
        font: fixtureFontFamily,
      });
    samples.push(performance.now() - start);
  }
  return {
    medianMs: summarize(samples).median,
    p95Ms: summarize(samples).p95,
    runs,
    // Nonzero-count assert lives in tests/layout-baseline-harness.test.ts and
    // the smoke gate; zero here would mean the measurer was never called.
    measureCalls: measurer.state.count - callsBefore,
  };
}

/** Measurer wrapper carrying its own counters so frames and microbenchmark
 * never share numbers. */
export interface MeasurerState {
  measureText: MeasureText;
  state: { count: number };
}
export function instrumentedMeasurer(viewRenderer: {
  measureText: MeasureText;
}): MeasurerState {
  const state = { count: 0 };
  const measureText: MeasureText = (text, font, tracking) => {
    state.count++;
    return viewRenderer.measureText(text, font, tracking);
  };
  return { measureText, state };
}

export async function runHarness(options: HarnessRunOptions): Promise<{
  result: HarnessRunResult;
  frames: { time: number; pngBase64: string }[];
}> {
  validateRunOptions(options);
  const font = await loadFixtureFont((file) => `/tests/fixtures/fonts/${file}`);
  const counters: GpuCounters = {
    beginRenderPasses: 0,
    renderTargetTexturesCreated: 0,
    otherTexturesCreated: 0,
  };

  // FrameSource.create requests its own device through navigator.gpu, so the
  // benchmark-only wrapper is installed once for the WHOLE run — creation,
  // warmup, every measured frame, pixel capture and disposal — and restored
  // exactly once in finally, including failure paths. Restoring it earlier
  // silently drops every pass and texture count to zero.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("No WebGPU adapter; environment blocked.");
  const realDevice = await adapter.requestDevice();
  const restoreEnvironment = installDeviceInstrumentation(realDevice, counters);
  // Only disposal is needed outside the try block; FrameSource is a dynamic
  // import so its type cannot be referenced before the scope below.
  let source: { dispose(): void } | undefined;
  const canvas2dProbe = canvas2dProbeEnabled(options);
  let measureProbe: Canvas2dMeasureTextProbe | undefined;
  try {
    // Before FrameSource.create, including its setup measureText calls. Font
    // proof already ran and is outside this interval.
    if (canvas2dProbe) measureProbe = installCanvas2dMeasureTextProbe();
    const resolution =
      options.fixture === "stress"
        ? ([1200, 900] as const)
        : ([960, 540] as const);

    const { Stage } = await import("../src/authoring/index");
    const { FrameSource } = await import("../src/engine/render/frame-source");
    const { regressionView, stressView } =
      await import("../tests/fixtures/layout-regression");

    // Production end-to-end path: FrameSource.create → Renderer.renderAsync
    // (prepare + render + submit inside Renderer) → queue.onSubmittedWorkDone
    // inside FrameSource.render — the actual offline CLI route, not a
    // re-sequenced copy of scene calls.
    const scene = Stage(
      options.fixture === "stress"
        ? () => stressView()
        : (stageContext: { localTime: number }) =>
            regressionView(stageContext.localTime),
      {
        designSize: [...resolution] as [number, number],
        theme: fixtureTheme(fixtureFontFamily),
      },
    );
    const project = {
      name: "layout-baseline",
      resolution,
      aspectRatio: resolution,
      duration: 6,
      settings: { version: 1 as const },
      scenes: [
        {
          id: "baseline",
          name: "Baseline stage",
          source: "stage",
          start: 0,
          duration: 6,
          transition: { type: "cut" as const },
          create: () => scene,
        },
      ],
    };
    measureProbe?.reset();
    const frameSource = await FrameSource.create(project, {
      width: resolution[0],
      height: resolution[1],
    });
    source = frameSource;
    const setupCanvas2d = measureProbe?.take();

    const frameTime = options.frameTime ?? 0;

    const renderOnce = async (time: number) => {
      const passesBefore = counters.beginRenderPasses;
      const renderStart = performance.now();
      // Reset at the await boundary so warmup, measured, and capture stay apart.
      measureProbe?.reset();
      await frameSource.render(time);
      return {
        endToEndMs: performance.now() - renderStart,
        beginRenderPasses: counters.beginRenderPasses - passesBefore,
        canvas2d: measureProbe?.take(),
      };
    };

    const warmupCanvas2d: Canvas2dFrameCount[] = [];
    for (let i = 0; i < options.warmup; i++) {
      const frame = await renderOnce(frameTime);
      if (frame.canvas2d) warmupCanvas2d.push(frame.canvas2d);
    }
    const renderTargetsAtMeasuredStart = counters.renderTargetTexturesCreated;

    const measuredEndToEnd: number[] = [];
    const measuredPasses: number[] = [];
    const measuredCanvas2d: Canvas2dFrameCount[] = [];
    for (let i = 0; i < options.measured; i++) {
      const frame = await renderOnce(frameTime);
      measuredEndToEnd.push(frame.endToEndMs);
      measuredPasses.push(frame.beginRenderPasses);
      if (frame.canvas2d) measuredCanvas2d.push(frame.canvas2d);
    }
    const creationsAtMeasuredEnd = counters.renderTargetTexturesCreated;

    // Pixel proof at declared states, including A→B→A repetition, through the
    // same production path. Capture-phase counters are recorded separately and
    // never merged into measured-phase metrics.
    const pixelStates = options.pixelStates ?? [0, 2.4, 0];
    const creationsBeforeCapture = counters.renderTargetTexturesCreated;
    const frames: { time: number; pngBase64: string }[] = [];
    const captureCanvas2d: Canvas2dFrameCount[] = [];
    for (const time of pixelStates) {
      measureProbe?.reset();
      const frameCanvas = await frameSource.render(time);
      const canvas2d = measureProbe?.take();
      if (canvas2d) captureCanvas2d.push(canvas2d);
      const blob = await frameCanvas.convertToBlob({ type: "image/png" });
      frames.push({
        time,
        pngBase64: await b64encode(await blob.arrayBuffer()),
      });
    }
    const captureRenderTargetCreations =
      counters.renderTargetTexturesCreated - creationsBeforeCapture;

    // Pixel calibration: decode every captured PNG to RGBA and compare decoded
    // pixel bytes. PNG byte equality is weaker and is not used as the verdict.
    const decodeRgba = async (base64: string) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const cv = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const rgba = await Promise.all(frames.map((f) => decodeRgba(f.pngBase64)));
    if (rgba.length < 3)
      throw Error("Pixel calibration requires three captured states (A→B→A).");
    let a1a2Differing = 0;
    let a1bDiffering = 0;
    for (let i = 0; i < rgba[0].length; i++) {
      if (rgba[0][i] !== rgba[2][i]) a1a2Differing++;
      if (rgba[0][i] !== rgba[1][i]) a1bDiffering++;
    }
    const pixelProof: PixelProof = {
      tolerance: "exact (decoded RGBA byte equality)",
      repeatIdentical: a1a2Differing === 0,
      repeatDifferingBytes: a1a2Differing,
      aVsBDifferingBytes: a1bDiffering,
      aVsBDiffer: a1bDiffering > 0,
    };
    assertPixelCalibration(options.fixture, pixelProof);

    const inspectStart = performance.now();
    const inspected = scene.inspect();
    const inspectMs = inspected ? performance.now() - inspectStart : undefined;

    if (!measuredPasses.some((passes) => passes > 0))
      throw Error(
        "GPU instrumentation recorded zero render passes across every measured frame; the device wrapper was not active.",
      );

    // Separate CPU microbenchmark: evaluateView with a delegating wrapper
    // around the production ViewRenderer.measureText path, using the same
    // fixture font as the frames. Canvas2D measurement needs no GPU resources,
    // so no setup is called (the frame device has been destroyed by dispose).
    // Its counters are independent and never merged into frame metrics.
    const viewRenderer = new (
      await import("../src/authoring/renderer")
    ).ViewRenderer();
    const microMeasurer = instrumentedMeasurer(viewRenderer);
    const micro = benchmarkLayoutCpu(options.fixture, frameTime, microMeasurer);
    viewRenderer.dispose();
    const tree = inspectLayout(options.fixture, microMeasurer.measureText);

    // Honest reuse accounting: the composition surface cache lives inside
    // ViewRenderer and is not observable from outside without production
    // changes. Only the measured-phase creation delta is reported; per-path
    // reuse is explicitly UNAVAILABLE.
    const measuredPhaseRenderTargetCreations = Math.max(
      0,
      creationsAtMeasuredEnd - renderTargetsAtMeasuredStart,
    );

    if (canvas2dProbe) {
      const measuredCalls = measuredCanvas2d.reduce(
        (sum, frame) => sum + frame.canvas2dMeasureTextCalls,
        0,
      );
      if (measuredCalls <= 0)
        throw Error(
          "Canvas 2D measureText probe recorded zero calls across measured frames of a text fixture; instrumentation was not active.",
        );
    }

    return {
      result: {
        fixture: options.fixture,
        fontProof: font,
        warmup: options.warmup,
        measured: options.measured,
        // Production end-to-end frame time: FrameSource.render through GPU
        // completion. This is the ONLY total-frame metric.
        endToEndMs: summarize(measuredEndToEnd),
        // Scene-level CPU microbenchmark, explicitly NOT a frame phase and
        // never added to endToEndMs.
        layoutCpuMicrobenchmark: micro,
        // Exact ViewRenderer.measureText calls are still unavailable. The
        // canvas total is a different metric and is not stored here.
        measureCalls: {
          available: false as const,
          reason:
            "ViewRenderer.measureText is an instance field on Stage's internal renderer. canvas2dMeasureText includes rasterization and is not this count.",
        },
        canvas2dMeasureText:
          canvas2dProbe && setupCanvas2d
            ? assembleCanvas2dReport({
                setup: setupCanvas2d,
                warmup: warmupCanvas2d,
                measured: measuredCanvas2d,
                capture: captureCanvas2d,
              })
            : unavailableCanvas2dMeasureText(),
        frameTiming: frameTimingDistribution(canvas2dProbe),
        g7: { complete: false as const },
        pixelProof,
        gpu: {
          beginRenderPasses: summarize(measuredPasses),
          renderTargetTexturesCreated: counters.renderTargetTexturesCreated,
          otherTexturesCreated: counters.otherTexturesCreated,
          // Creation delta over measured frames only (setup/warmup/capture
          // excluded). Reuse is NOT derivable from this and is unavailable.
          measuredPhaseRenderTargetCreations,
          capturePhaseRenderTargetCreations: captureRenderTargetCreations,
          texturesReused: {
            available: false as const,
            reason:
              "ViewRenderer surface cache is internal; reuse observation requires production instrumentation",
          },
          availability: "measured" as const,
        },
        tree: {
          layoutNodes: tree.count,
          drawCommands: tree.commands,
          textRuns: tree.textRuns,
          distinctTexts: tree.distinctTexts,
          width: resolution[0],
          height: resolution[1],
        },
        inspect:
          inspectMs === undefined
            ? { available: false }
            : { available: true, ms: inspectMs },
        inspectionCli: {
          available: false,
          reason:
            "G1b added the inspect CLI; its latency is measured by scripts/validate-inspect.mjs, not this page harness",
        },
        fixtureCounts: {
          expectedLayoutNodes:
            options.fixture === "stress" ? stressExpectedLayoutNodeCount : null,
          actualLayoutNodes: tree.count,
        },
      },
      frames,
    };
  } finally {
    // Restore the native environment even if disposal or descriptor restore throws.
    try {
      source?.dispose();
    } finally {
      try {
        restoreEnvironment();
      } finally {
        measureProbe?.restore();
      }
    }
  }
}

function inspectLayout(
  fixture: "regression" | "stress",
  measureText: MeasureText,
): {
  count: number;
  commands: number;
  textRuns: number;
  distinctTexts: number;
} {
  // Both fixtures must be inspected with the same font the frames render with.
  const frame =
    fixture === "stress"
      ? evaluateStress(0, { measureText, font: fixtureFontFamily })
      : evaluateRegression(0, { measureText, font: fixtureFontFamily });
  const textRuns = frame.commands.filter((c) => c.kind === "text");
  return {
    count: countLayoutNodes(frame.tree),
    commands: frame.commands.length,
    textRuns: textRuns.length,
    distinctTexts: new Set(textRuns.map((c) => c.text.lines.join("\n"))).size,
  };
}
