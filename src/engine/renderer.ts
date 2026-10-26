import type { Project, Scene } from "./types";
import { evaluate, validateProject } from "./timeline";
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
    const encoder = this.device.createCommandEncoder();
    this.scenes.get(evaluation.entry.id)!.render({
      device: this.device,
      format: this.format,
      resolution: this.resolution,
      target: this.context.getCurrentTexture(),
      encoder,
      ...evaluation,
    });
    this.device.queue.submit([encoder.finish()]);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
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
