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
