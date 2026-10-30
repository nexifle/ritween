import type { Project, Scene } from "../types";
import { evaluateActive, validateProject } from "../timeline";
import { TransitionRenderer } from "./transition";
import { matchSharedElements } from "./shared-elements";
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
  private transition?: TransitionRenderer;
  private overlay?: Scene;
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
      const setup = async (scene: Scene, name: string) => {
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
        if (error) throw Error(`${name}: ${error.message}`);
      };
      for (const entry of project.scenes) {
        signal?.throwIfAborted();
        const scene = entry.create();
        renderer.scenes.set(entry.id, scene);
        await setup(scene, entry.name);
      }
      if (project.overlay) {
        signal?.throwIfAborted();
        renderer.overlay = project.overlay();
        await setup(renderer.overlay, "Project overlay");
      }
      signal?.throwIfAborted();
      if (project.scenes.some((s) => s.transition.type !== "cut"))
        renderer.transition = new TransitionRenderer({
          device,
          format,
          resolution: renderer.resolution,
        });
      if (renderer.transition)
        await renderer.transition.prepare(
          project.scenes.map((s) => s.transition),
        );
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
  /** Release canvas ownership without destroying the prepared scenes. */
  detachCanvas() {
    if (this.configured) this.context.unconfigure();
    this.configured = false;
  }
  /** Attach a prepared preview only after its replacement is ready to commit. */
  attachCanvas(canvas: HTMLCanvasElement) {
    if (this.disposed) throw Error("Renderer is disposed.");
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw Error("Could not create the WebGPU canvas context.");
    if (canvas.width !== this.resolution[0]) canvas.width = this.resolution[0];
    if (canvas.height !== this.resolution[1])
      canvas.height = this.resolution[1];
    context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    if (this.configured && this.context !== context) this.context.unconfigure();
    this.context = context;
    this.configured = true;
  }
  render(time: number) {
    if (this.disposed) throw Error("Renderer is disposed.");
    const evaluation = evaluateActive(this.project, time);
    for (const active of evaluation.active)
      if (this.scenes.get(active.entry.id)!.prepareFrame)
        throw Error(
          `${active.entry.name} prepares frames asynchronously. Use await renderer.renderAsync(${time}) instead of renderer.render(${time}).`,
        );
    if (this.overlay?.prepareFrame)
      throw Error(
        "Project overlay prepares frames asynchronously. Use await renderer.renderAsync(time) instead.",
      );
    this.renderGeneration++;
    this.abortPreparations(
      new DOMException(
        "Frame preparation superseded by sync rendering.",
        "AbortError",
      ),
    );
    this.deactivateOtherMedia(
      evaluation.active.map((a) => this.scenes.get(a.entry.id)!),
    );
    this.submitFrame(evaluation);
  }
  private deactivateOtherMedia(active: readonly Scene[]) {
    for (const scene of this.scenes.values())
      if (!active.includes(scene)) managedVideoScenes.get(scene)?.deactivate();
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
      const evaluation = evaluateActive(this.project, time);
      this.deactivateOtherMedia(
        evaluation.active.map((a) => this.scenes.get(a.entry.id)!),
      );
      for (const active of evaluation.active) {
        this.assertCurrentFrame(generation, controller.signal);
        await this.scenes.get(active.entry.id)!.prepareFrame?.({
          time: active.time,
          localTime: active.localTime,
          progress: active.progress,
          signal: controller.signal,
        });
      }
      this.assertCurrentFrame(generation, controller.signal);
      await this.overlay?.prepareFrame?.({
        ...this.overlayTiming(evaluation.primary.time),
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
  private overlayTiming(time: number) {
    return { time, localTime: time, progress: time / this.project.duration };
  }
  private submitFrame(evaluation: ReturnType<typeof evaluateActive>) {
    const encoder = this.device.createCommandEncoder();
    const target = this.context.getCurrentTexture();
    const context = {
      device: this.device,
      format: this.format,
      resolution: this.resolution,
      compositionResolution: this.project.resolution,
      target,
      encoder,
    };
    if (evaluation.transition) {
      if (!this.transition) throw Error("Transition compositor is not ready.");
      const shared =
        evaluation.transition.type === "shared"
          ? matchSharedElements(
              this.scenes
                .get(evaluation.active[0].entry.id)!
                .sharedElements?.({ ...context, ...evaluation.active[0] }) ??
                [],
              this.scenes
                .get(evaluation.active[1].entry.id)!
                .sharedElements?.({ ...context, ...evaluation.active[1] }) ??
                [],
              evaluation.transition.progress,
            )
          : undefined;
      evaluation.active.forEach((active, i) => {
        const target = this.transition!.targets[i];
        encoder
          .beginRenderPass({
            colorAttachments: [
              {
                view: target.createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
          })
          .end();
        this.scenes.get(active.entry.id)!.render({
          ...context,
          ...active,
          target,
          sharedTransforms: shared?.[i],
        });
      });
      this.transition.render(
        { ...context, ...evaluation.primary },
        evaluation.transition,
      );
    } else
      this.scenes
        .get(evaluation.primary.entry.id)!
        .render({ ...context, ...evaluation.primary });
    this.overlay?.render({
      ...context,
      ...this.overlayTiming(evaluation.primary.time),
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
      for (const [id, scene] of this.scenes) {
        try {
          scene.dispose();
        } catch (error) {
          // A custom scene must not prevent cleanup of the remaining resources.
          console.error(`Could not dispose scene ${id}:`, error);
        }
      }
    } finally {
      this.scenes.clear();
      try {
        this.overlay?.dispose();
      } catch (error) {
        console.error("Could not dispose project overlay:", error);
      }
      this.overlay = undefined;
      this.transition?.dispose();
      try {
        if (this.configured) this.context.unconfigure();
      } finally {
        this.device.destroy();
      }
    }
  }
}
