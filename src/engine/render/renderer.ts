import type { Project, Scene } from "../types";
import { evaluate, validateProject } from "../timeline";
import { managedVideoScenes } from "./visual";
/** Observe late setup failures even after a sibling pipeline cancels this wait. */
function waitForSetup<T>(
  work: T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    Promise.resolve(work).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
export class Renderer {
  private scenes = new Map<string, Scene>();
  private disposed = false;
  private configured = false;
  private renderGeneration = 0;
  private preparationQueue: Promise<void> = Promise.resolve();
  private activeFrames = new Set<AbortController>();
  private constructor(
    readonly device: GPUDevice,
    private context: GPUCanvasContext,
    readonly project: Project,
    readonly resolution: readonly [number, number],
    readonly format: GPUTextureFormat,
  ) {}
  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    project: Project,
    onError: (message: string) => void = () => {},
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    validateProject(project);
    if (!navigator.gpu)
      throw Error(
        "WebGPU is unavailable. Open localhost in a current Chrome or Edge with GPU acceleration enabled.",
      );
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
      throw Error(
        "No WebGPU adapter found. Enable GPU acceleration and reload.",
      );
    signal?.throwIfAborted();
    const device = await adapter.requestDevice();
    if (signal?.aborted) {
      device.destroy();
      signal.throwIfAborted();
    }
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) {
      device.destroy();
      throw Error("Could not create the WebGPU canvas context.");
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    const renderer = new Renderer(
      device,
      context,
      project,
      [canvas.width, canvas.height],
      format,
    );
    device.addEventListener("uncapturederror", (e) =>
      onError(`GPU: ${e.error.message}`),
    );
    void device.lost.then((info) => {
      if (!renderer.disposed)
        onError(`GPU device lost: ${info.message}. Reload to reconnect.`);
    });
    try {
      for (const entry of project.scenes) {
        signal?.throwIfAborted();
        const scene = entry.create();
        renderer.scenes.set(entry.id, scene);
        device.pushErrorScope("validation");
        let setupError: unknown;
        try {
          await waitForSetup(
            scene.setup({
              device,
              format,
              resolution: renderer.resolution,
              compositionResolution: project.resolution,
            }),
            signal,
          );
        } catch (error) {
          setupError = error;
        }
        const error = await waitForSetup(device.popErrorScope(), signal);
        if (setupError) throw setupError;
        if (error) throw Error(`${entry.name}: ${error.message}`);
      }
      signal?.throwIfAborted();
      context.configure({
        device,
        format,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      renderer.configured = true;
      return renderer;
    } catch (error) {
      renderer.dispose();
      throw error;
    }
  }
  render(time: number) {
    if (this.disposed) throw Error("Renderer is disposed.");
    const evaluation = evaluate(this.project, time);
    const scene = this.scenes.get(evaluation.entry.id)!;
    if (scene.prepareFrame)
      throw Error(
        `${evaluation.entry.name} prepares frames asynchronously. Use await renderer.renderAsync(${time}) instead of renderer.render(${time}).`,
      );
    this.renderGeneration++;
    this.abortPreparations(
      new DOMException(
        "Frame preparation superseded by sync rendering.",
        "AbortError",
      ),
    );
    this.deactivateOtherMedia(scene);
    this.submitFrame(evaluation);
  }
  private deactivateOtherMedia(active: Scene) {
    for (const scene of this.scenes.values())
      if (scene !== active) managedVideoScenes.get(scene)?.deactivate();
  }
  async renderAsync(time: number, signal?: AbortSignal) {
    if (this.disposed) throw Error("Renderer is disposed.");
    signal?.throwIfAborted();
    const generation = this.renderGeneration;
    const controller = new AbortController();
    this.activeFrames.add(controller);
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });

    const work = this.preparationQueue.then(async () => {
      this.assertCurrentFrame(generation, controller.signal);
      const evaluation = evaluate(this.project, time);
      const scene = this.scenes.get(evaluation.entry.id)!;
      this.deactivateOtherMedia(scene);
      if (scene.prepareFrame)
        await scene.prepareFrame({
          time: evaluation.time,
          localTime: evaluation.localTime,
          progress: evaluation.progress,
          signal: controller.signal,
        });
      this.assertCurrentFrame(generation, controller.signal);
      this.submitFrame(evaluation);
    });
    const result = work.finally(() => {
      signal?.removeEventListener("abort", forwardAbort);
      this.activeFrames.delete(controller);
    });
    this.preparationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private abortPreparations(reason: DOMException) {
    for (const controller of [...this.activeFrames]) controller.abort(reason);
  }
  private assertCurrentFrame(generation: number, signal: AbortSignal) {
    if (this.disposed)
      throw new DOMException(
        "Renderer was disposed during frame preparation.",
        "AbortError",
      );
    signal.throwIfAborted();
    if (generation !== this.renderGeneration)
      throw new DOMException("Frame preparation was superseded.", "AbortError");
  }
  private submitFrame(evaluation: ReturnType<typeof evaluate>) {
    const encoder = this.device.createCommandEncoder();
    this.scenes.get(evaluation.entry.id)!.render({
      device: this.device,
      format: this.format,
      resolution: this.resolution,
      compositionResolution: this.project.resolution,
      target: this.context.getCurrentTexture(),
      encoder,
      ...evaluation,
    });
    this.device.queue.submit([encoder.finish()]);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderGeneration++;
    this.abortPreparations(
      new DOMException("Renderer was disposed.", "AbortError"),
    );
    try {
      for (const scene of this.scenes.values()) scene.dispose();
    } finally {
      this.scenes.clear();
      try {
        if (this.configured) this.context.unconfigure();
      } finally {
        this.device.destroy();
      }
    }
  }
}
