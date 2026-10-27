import assert from "node:assert/strict";
import test from "node:test";
import { FrameSource } from "../src/engine/render/frame-source";
import { Renderer } from "../src/engine/render/renderer";
import type { Project } from "../src/engine/types";

test("offline frames wait for GPU completion, reuse the canvas and honor cancellation", async () => {
  const originalCreate = Renderer.create;
  const originalCanvas = globalThis.OffscreenCanvas;
  const times: number[] = [];
  let disposed = 0;
  let complete!: () => void;
  const gpuWork = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const controller = new AbortController();
  globalThis.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
  } as typeof OffscreenCanvas;
  Renderer.create = async () =>
    ({
      render: (time: number) => times.push(time),
      device: { queue: { onSubmittedWorkDone: () => gpuWork } },
      dispose: () => {
        disposed++;
      },
    }) as unknown as Renderer;
  try {
    const source = await FrameSource.create({} as Project, {
      width: 320,
      height: 240,
      signal: controller.signal,
    });
    try {
      let resolved = false;
      const first = source.render(0).then((canvas) => {
        resolved = true;
        return canvas;
      });
      await Promise.resolve();
      assert.equal(resolved, false);
      complete();
      const canvas = await first;
      assert.equal(canvas.width, 320);
      assert.equal(canvas.height, 240);
      assert.equal(await source.render(0.5), canvas);
      const reason = Error("cancelled");
      controller.abort(reason);
      await assert.rejects(source.render(1), (error) => error === reason);
      assert.deepEqual(times, [0, 0.5]);
    } finally {
      source.dispose();
    }
    assert.equal(disposed, 1);
  } finally {
    Renderer.create = originalCreate;
    if (originalCanvas === undefined)
      Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    else globalThis.OffscreenCanvas = originalCanvas;
  }
});
