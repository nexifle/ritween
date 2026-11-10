/**
 * Self-checks for the G0/G7 baseline harness: statistics, argument validation,
 * and the instrumented-device counters (pass counting, render-target vs other
 * texture classification, receiver preservation). GPU-dependent paths are
 * exercised in the browser by scripts/layout-baseline-run.mjs; these tests
 * cover the pure logic without WebGPU.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarize,
  validateRunOptions,
  instrumentDevice,
  installDeviceInstrumentation,
  assertPixelCalibration,
  benchmarkLayoutCpu,
  instrumentedMeasurer,
  installCanvas2dMeasureTextProbe,
  canvas2dProbeEnabled,
  assembleCanvas2dReport,
  unavailableCanvas2dMeasureText,
  frameTimingDistribution,
  runHarness,
} from "../scripts/layout-baseline-harness";
import type { GpuCounters } from "../scripts/layout-baseline-harness";

test("summarize returns the conventional median and nearest-rank p95", () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 5]), { median: 3, p95: 5 });
  // Even counts average the two middle sorted values, as §13.4's median requires.
  assert.equal(summarize([1, 2, 3, 4]).median, 2.5);
  assert.equal(summarize([10, 20, 30, 40]).median, 25);
  // The 300-frame default is an even count: the two middle samples average.
  const threeHundred = Array.from({ length: 300 }, (_, i) => i + 1);
  assert.equal(summarize(threeHundred).median, 150.5);
  // p95 stays nearest-rank: ceil(0.95*20)-1 = index 18, a real sample value.
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(summarize(twenty).p95, 19);
  assert.equal(summarize(threeHundred).p95, 285);
  // Input order must not matter and the input must not be mutated.
  const shuffled = [5, 1, 4, 2, 3];
  assert.deepEqual(summarize(shuffled), { median: 3, p95: 5 });
  assert.deepEqual(shuffled, [5, 1, 4, 2, 3]);
});

test("summarize rejects empty samples and single values are their own summary", () => {
  assert.throws(() => summarize([]), /empty/);
  assert.deepEqual(summarize([42]), { median: 42, p95: 42 });
});

test("validateRunOptions enforces fixture names and non-negative counts", () => {
  assert.doesNotThrow(() =>
    validateRunOptions({ fixture: "stress", warmup: 60, measured: 300 }),
  );
  assert.throws(
    () =>
      validateRunOptions({
        fixture: "other" as "stress",
        warmup: 60,
        measured: 300,
      }),
    /Unknown fixture/,
  );
  assert.throws(
    () => validateRunOptions({ fixture: "stress", warmup: -1, measured: 300 }),
    /warmup/,
  );
  assert.throws(
    () => validateRunOptions({ fixture: "stress", warmup: 60, measured: 0 }),
    /measured/,
  );
  assert.throws(
    () =>
      validateRunOptions({
        fixture: "stress",
        warmup: 60,
        measured: 300,
        frameTime: Number.NaN,
      }),
    /frameTime/,
  );
});

/** Minimal GPUDevice/encoder stand-ins mirroring the real call shapes. */
interface FakeTextureDescriptor {
  size: [number, number];
  format: string;
  usage: number;
}
function fakeDevice() {
  const calls = { encoders: 0, textures: [] as FakeTextureDescriptor[] };
  const beginPassArgs: unknown[] = [];
  const device = {
    createCommandEncoder() {
      calls.encoders++;
      return {
        beginRenderPass(descriptor: unknown) {
          beginPassArgs.push(descriptor);
          return { ended: false };
        },
      };
    },
    createTexture(descriptor: FakeTextureDescriptor) {
      calls.textures.push(descriptor);
      return { descriptor };
    },
  };
  return { device: device as unknown as GPUDevice, calls, beginPassArgs };
}

const RENDER_ATTACHMENT = 0x10;
const zeroCounters = (): GpuCounters => ({
  beginRenderPasses: 0,
  renderTargetTexturesCreated: 0,
  otherTexturesCreated: 0,
});

test("instrumentDevice counts beginRenderPass and classifies textures by usage", () => {
  const { device, calls } = fakeDevice();
  const counters = zeroCounters();
  const proxy = instrumentDevice(device, counters);
  const encoder = proxy.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [] });
  encoder.beginRenderPass({ colorAttachments: [] });
  proxy.createTexture({
    size: [4, 4],
    format: "rgba8unorm",
    usage: RENDER_ATTACHMENT,
  });
  proxy.createTexture({ size: [4, 4], format: "rgba8unorm", usage: 2 });
  assert.equal(counters.beginRenderPasses, 2);
  assert.equal(counters.renderTargetTexturesCreated, 1);
  assert.equal(counters.otherTexturesCreated, 1);
  assert.equal(calls.encoders, 1);
  assert.equal(calls.textures.length, 2);
});

test("instrumentDevice forwards pass arguments unchanged", () => {
  const { device, beginPassArgs } = fakeDevice();
  const proxy = instrumentDevice(device, zeroCounters());
  const descriptor = {
    colorAttachments: [
      {
        view: {} as GPUTextureView,
        loadOp: "clear" as const,
        storeOp: "store" as const,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  };
  proxy.createCommandEncoder().beginRenderPass(descriptor);
  assert.equal(beginPassArgs[0], descriptor);
});

/**
 * The wrapper installs through `navigator`, so these tests swap that global for
 * a stand-in and assert the restore contract: an own descriptor comes back
 * verbatim, and a property that was only inherited must not be left as an own
 * shadow (assigning the native value back would leave one).
 */
function withFakeNavigator<T>(fake: object, run: () => T): T {
  // Node exposes navigator as a getter-only accessor; redefine and restore.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: fake,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "navigator", saved);
  }
}

test("installDeviceInstrumentation restores an own descriptor verbatim", () => {
  const { device } = fakeDevice();
  const nativeCreateTexture = device.createTexture;
  const nativeCreateCommandEncoder = device.createCommandEncoder;
  const nativeGpu = { marker: "own" };
  const ownNavigator = { gpu: nativeGpu };

  withFakeNavigator(ownNavigator, () => {
    const restore = installDeviceInstrumentation(device, zeroCounters());
    assert.notEqual(ownNavigator.gpu, nativeGpu);
    assert.notEqual(device.createTexture, nativeCreateTexture);
    assert.notEqual(device.createCommandEncoder, nativeCreateCommandEncoder);
    restore();
  });

  const descriptor = Object.getOwnPropertyDescriptor(ownNavigator, "gpu")!;
  assert.equal(descriptor.value, nativeGpu);
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.configurable, true);
  assert.equal(device.createTexture, nativeCreateTexture);
  assert.equal(device.createCommandEncoder, nativeCreateCommandEncoder);
});

test("installDeviceInstrumentation leaves an inherited property inherited", () => {
  const nativeGpu = { inherited: true };
  const target = Object.create({ gpu: nativeGpu }) as { gpu?: unknown };
  const { device } = fakeDevice();

  withFakeNavigator(target, () => {
    const restore = installDeviceInstrumentation(device, zeroCounters());
    assert.equal(Object.hasOwn(target, "gpu"), true);
    restore();
  });

  assert.equal(Object.hasOwn(target, "gpu"), false);
  assert.equal(target.gpu, nativeGpu);
});

test("assertPixelCalibration enforces repeat identity and per-fixture contrast", () => {
  const stable = {
    repeatIdentical: true,
    repeatDifferingBytes: 0,
    aVsBDiffer: true,
    aVsBDifferingBytes: 120,
  };
  assert.doesNotThrow(() => assertPixelCalibration("regression", stable));
  assert.throws(
    () =>
      assertPixelCalibration("regression", { ...stable, aVsBDiffer: false }),
    /no motion/,
  );
  assert.throws(
    () =>
      assertPixelCalibration("regression", {
        ...stable,
        repeatIdentical: false,
      }),
    /not deterministic/,
  );
  // The stress fixture is static by construction: state contrast is a failure.
  assert.throws(
    () => assertPixelCalibration("stress", stable),
    /static stress fixture changed/,
  );
  assert.doesNotThrow(() =>
    assertPixelCalibration("stress", {
      ...stable,
      aVsBDiffer: false,
      aVsBDifferingBytes: 0,
    }),
  );
});

test("benchmarkLayoutCpu counts measurer calls for both fixtures", () => {
  const measurer = instrumentedMeasurer({
    // Stand-in for ViewRenderer.measureText; the real path is Canvas 2D.
    measureText: (text: string) => Array.from(text).length * 10,
  });
  for (const fixture of ["regression", "stress"] as const) {
    const before = measurer.state.count;
    const result = benchmarkLayoutCpu(fixture, 0, measurer, 3);
    assert.equal(result.runs, 3);
    assert.ok(result.measureCalls > 0, `${fixture} must measure text`);
    assert.equal(measurer.state.count - before, result.measureCalls);
    assert.ok(result.medianMs >= 0);
  }
});

function fakeMeasurePrototype() {
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  const metrics = { width: 12 };
  function measureText(this: unknown, ...args: unknown[]) {
    calls.push({ receiver: this, args });
    return metrics;
  }
  const proto = { measureText };
  return { proto, calls, metrics, measureText };
}

test("canvas2d measureText probe forwards, counts, and restores the descriptor", () => {
  const { proto, calls, metrics, measureText } = fakeMeasurePrototype();
  const descriptor = Object.getOwnPropertyDescriptor(proto, "measureText")!;
  const receiver = Object.create(proto);
  const probe = installCanvas2dMeasureTextProbe(proto);
  try {
    assert.throws(
      () => installCanvas2dMeasureTextProbe(proto),
      /nested wrappers/,
    );
    assert.throws(
      () => installCanvas2dMeasureTextProbe({ measureText() {} }),
      /Concurrent probes/,
    );
    const returned = receiver.measureText("hello", 1);
    assert.equal(returned, metrics);
    assert.equal(calls[0].receiver, receiver);
    assert.deepEqual(calls[0].args, ["hello", 1]);
    receiver.measureText("Mg");
    const during = probe.take();
    assert.equal(during.canvas2dMeasureTextCalls, 2);
    assert.equal(during.rasterMgCalls, 1);
    receiver.measureText("Mg ");
    receiver.measureText("after");
    assert.equal(probe.snapshot().canvas2dMeasureTextCalls, 2);
    assert.equal(probe.snapshot().rasterMgCalls, 0);
  } finally {
    probe.restore();
  }
  assert.equal(proto.measureText, measureText);
  const restored = Object.getOwnPropertyDescriptor(proto, "measureText")!;
  assert.equal(restored.value, descriptor.value);
  assert.equal(restored.enumerable, descriptor.enumerable);
  assert.equal(restored.writable, descriptor.writable);
  assert.equal(restored.configurable, descriptor.configurable);
  probe.restore();
  const again = installCanvas2dMeasureTextProbe(proto);
  again.restore();
  assert.equal(proto.measureText, measureText);
});

test("canvas2d measureText probe preserves the thrown exception and receiver", () => {
  const failure = new Error("measure failed");
  const seen: unknown[] = [];
  const proto = {
    measureText(this: unknown, text: string) {
      seen.push(this);
      if (text === "boom") throw failure;
      return { width: text.length, text };
    },
  };
  const native = proto.measureText;
  const probe = installCanvas2dMeasureTextProbe(proto);
  const receiver = Object.create(proto);
  try {
    const value = receiver.measureText("ok");
    assert.equal(value.text, "ok");
    assert.equal(seen[0], receiver);
    assert.throws(
      () => receiver.measureText("boom"),
      (error) => error === failure,
    );
    assert.equal(probe.snapshot().canvas2dMeasureTextCalls, 2);
    assert.equal(probe.snapshot().rasterMgCalls, 0);
  } finally {
    probe.restore();
  }
  assert.equal(proto.measureText, native);
  const frozen = probe.snapshot().canvas2dMeasureTextCalls;
  receiver.measureText("later");
  assert.equal(probe.snapshot().canvas2dMeasureTextCalls, frozen);
});

test("canvas2d measureText probe restores an inherited method without leaving an own shadow", () => {
  const parent = {
    measureText(text: string) {
      return text;
    },
  };
  const proto = Object.create(parent) as {
    measureText?: (text: string) => string;
  };
  const probe = installCanvas2dMeasureTextProbe(proto);
  try {
    assert.equal(Object.hasOwn(proto, "measureText"), true);
    assert.equal(proto.measureText?.("Mg"), "Mg");
    assert.equal(probe.snapshot().rasterMgCalls, 1);
    throw Error("render failed");
  } catch (error) {
    assert.equal((error as Error).message, "render failed");
  } finally {
    probe.restore();
  }
  assert.equal(Object.hasOwn(proto, "measureText"), false);
  assert.equal(proto.measureText, parent.measureText);
});

test("canvas2d phase report keeps intervals apart and does not invent unavailable counts", () => {
  const report = assembleCanvas2dReport({
    setup: { canvas2dMeasureTextCalls: 5, rasterMgCalls: 0 },
    warmup: [
      { canvas2dMeasureTextCalls: 8, rasterMgCalls: 3 },
      { canvas2dMeasureTextCalls: 2, rasterMgCalls: 0 },
    ],
    measured: [
      { canvas2dMeasureTextCalls: 4, rasterMgCalls: 0 },
      { canvas2dMeasureTextCalls: 4, rasterMgCalls: 1 },
      { canvas2dMeasureTextCalls: 6, rasterMgCalls: 0 },
    ],
    capture: [],
  });
  assert.equal(
    report.semantics.includes("Not a ViewRenderer.measureText count"),
    true,
  );
  assert.equal(report.setup.canvas2dMeasureTextCalls, 5);
  assert.equal(report.measured.frames, 3);
  assert.equal(report.measured.totalCanvas2dMeasureTextCalls, 14);
  assert.equal(report.measured.totalRasterMgCalls, 1);
  assert.deepEqual(
    report.measured.perFrame.map((frame) => frame.canvas2dMeasureTextCalls),
    [4, 4, 6],
  );
  assert.equal(report.measured.callsSummary.median, 4);
  assert.equal(
    "frames" in report.warmup && report.warmup.totalCanvas2dMeasureTextCalls,
    10,
  );
  assert.equal(report.capture.available, false);
  assert.equal(report.layoutMeasurerCalls.available, false);
  assert.equal(report.rootMeasurementCanvasCalls.available, false);
  assert.equal(report.textReuse.available, false);
  assert.equal("count" in report.layoutMeasurerCalls, false);
  assert.equal("count" in report.textReuse, false);

  const off = unavailableCanvas2dMeasureText();
  assert.equal(off.available, false);
  assert.equal("canvas2dMeasureTextCalls" in off, false);

  const instrumented = frameTimingDistribution(true);
  assert.equal(instrumented.comparableToFrozenUninstrumentedBaseline, false);
  assert.equal(instrumented.performanceGate, "not-applicable");
  assert.match(instrumented.reason, /overhead/);
  assert.match(instrumented.reason, /performance improvement/);
  assert.match(instrumented.reason, /passing G7 gate/);
  const plain = frameTimingDistribution(false);
  assert.equal(plain.distribution, "uninstrumented");
  assert.equal(plain.performanceGate, "not-applicable");
});

test("canvas2d probe stays off unless the harness option is explicitly true", () => {
  assert.equal(canvas2dProbeEnabled({}), false);
  assert.equal(canvas2dProbeEnabled({ canvas2dProbe: undefined }), false);
  assert.equal(canvas2dProbeEnabled({ canvas2dProbe: false }), false);
  assert.equal(canvas2dProbeEnabled({ canvas2dProbe: true }), true);

  const proto = {
    measureText(text: string) {
      return text;
    },
  };
  const before = Object.getOwnPropertyDescriptor(proto, "measureText");
  for (const options of [
    {},
    { canvas2dProbe: undefined },
    { canvas2dProbe: false as const },
  ]) {
    assert.equal(canvas2dProbeEnabled(options), false);
    const off = unavailableCanvas2dMeasureText();
    assert.equal(off.available, false);
    assert.equal("setup" in off, false);
    assert.equal("canvas2dMeasureTextCalls" in off, false);
    assert.equal(off.layoutMeasurerCalls.available, false);
    assert.equal(off.textReuse.available, false);
    assert.equal("count" in off.layoutMeasurerCalls, false);
    assert.equal("count" in off.textReuse, false);
    const timing = frameTimingDistribution(canvas2dProbeEnabled(options));
    assert.equal(timing.distribution, "uninstrumented");
    assert.equal(timing.comparableToFrozenUninstrumentedBaseline, true);
    assert.equal(timing.performanceGate, "not-applicable");
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(proto, "measureText"),
    before,
  );
  assert.match(runHarness.toString(), /canvas2dProbeEnabled\(options\)/);
  assert.doesNotMatch(runHarness.toString(), /canvas2dProbe !== false/);

  const probe = canvas2dProbeEnabled({ canvas2dProbe: true })
    ? installCanvas2dMeasureTextProbe(proto)
    : undefined;
  assert.ok(probe);
  try {
    assert.notEqual(
      Object.getOwnPropertyDescriptor(proto, "measureText")?.value,
      before?.value,
    );
    assert.equal(proto.measureText("Mg"), "Mg");
    const timing = frameTimingDistribution(
      canvas2dProbeEnabled({ canvas2dProbe: true }),
    );
    assert.equal(
      timing.distribution,
      "instrumented-canvas2d-measureText-wrapper",
    );
    assert.equal(timing.comparableToFrozenUninstrumentedBaseline, false);
  } finally {
    probe.restore();
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(proto, "measureText"),
    before,
  );
});
