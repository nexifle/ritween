import type { Project, Scene, SceneInspection } from "../types";
import { evaluateActive, validateProject } from "../timeline";
import { TransitionRenderer } from "./transition";
import { matchSharedElements } from "./shared-elements";
import { managedVideoScenes } from "./visual";
/** Frame data of an inspectable scene, or an explicit reason the scene cannot provide one. */
export type InspectedLayer =
  | { readonly frame: SceneInspection; readonly unavailable?: never }
  | { readonly unavailable: string; readonly frame?: never };
/** Project clock of an inspected active layer. */
export interface InspectionClock {
  /** Requested composition time of the inspected frame, in seconds. */
  readonly time: number;
  /** Composition time mapped into this layer's own clock. */
  readonly localTime: number;
  /** Fractional position within this layer's own duration. */
  readonly progress: number;
}
/** One active scene of the last successful frame, in paint order. */
export type InspectedScene = InspectionClock &
  InspectedLayer & { readonly id: string; readonly name: string };
/**
 * Draw path captured at submit. `uniform` is an owned copy of the four uploaded
 * float32 controls, never the Transition object or a custom shader.
 * Built-in draws keep the outgoing and incoming scene ids from that submit.
 * `shared` is the kind-0 crossfade shader; leaf correction is already in the records.
 * Custom draws do not carry endpoint ids and are not a shader capture.
 */
export type TransitionDraw =
  | {
      readonly kind: "direct";
      readonly output: readonly [number, number];
    }
  | {
      readonly kind: "crossfade" | "shared" | "slide" | "zoom" | "wipe";
      readonly output: readonly [number, number];
      readonly uniform: readonly [number, number, number, number];
      readonly outgoingId: string;
      readonly incomingId: string;
    }
  | {
      readonly kind: "custom";
      readonly output: readonly [number, number];
      readonly uniform: readonly [number, number, number, number];
    };
/** Snapshot of the last successful frame; inspection is opt-in metadata, never pixels. */
export interface FrameInspection {
  /** Time passed to the successful render call, before timeline clamping. */
  readonly requestedTime: number;
  /** Clamped composition time the frame was evaluated at. */
  readonly effectiveTime: number;
  readonly scenes: readonly InspectedScene[];
  readonly overlay?: InspectionClock & InspectedLayer;
  /** Present only when inspection captured the draw. Absent means do not project. */
  readonly transitionDraw?: TransitionDraw;
}
/** Whether a returned value carries the structural frame data inspection promises. */
function isSceneInspection(value: unknown): value is SceneInspection {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<Record<keyof SceneInspection, unknown>>;
  return (
    "tree" in frame &&
    Array.isArray(frame.commands) &&
    Array.isArray(frame.warnings)
  );
}
/** Owned float32 copy of the uploaded controls. Reads indexes only, never a shader. */
function transitionDrawFrom(
  type: "crossfade" | "wipe" | "slide" | "zoom" | "shared" | "custom",
  uploaded: ArrayLike<number>,
  resolution: readonly [number, number],
  active: readonly { readonly entry: { readonly id: string } }[],
): TransitionDraw {
  const output: readonly [number, number] = [resolution[0], resolution[1]];
  const uniform = [uploaded[0], uploaded[1], uploaded[2], uploaded[3]] as const;
  if (type === "custom") return { kind: "custom", output, uniform };
  return {
    kind: type,
    output,
    uniform,
    outgoingId: active[0]?.entry.id ?? "",
    incomingId: active[1]?.entry.id ?? "",
  };
}
/** Read the capability once, with its receiver, because scenes may reuse the name for other data.
 * The property read, the call, and the shape check of the returned value (whose properties may
 * themselves be throwing getters or proxies) stay inside one handler: any of them failing reports
 * an unavailable layer instead of rejecting a frame whose GPU work was already submitted.
 */
function readLayer(scene: Scene | undefined, label: string): InspectedLayer {
  try {
    const capability = scene?.inspect;
    if (typeof capability !== "function")
      return {
        unavailable:
          capability === undefined
            ? `${label} does not implement the optional inspect() capability.`
            : `${label} inspect property is not a function.`,
      };
    const value = (capability as () => unknown).call(scene);
    if (isSceneInspection(value)) return { frame: value };
    return {
      unavailable:
        value === undefined
          ? `${label} returned no frame for this time.`
          : `${label} inspect() returned a value that is not a scene inspection.`,
    };
  } catch (error) {
    return {
      unavailable: `${label} inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
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
  /** Monotonic owner of each render attempt; only the newest attempt may publish a frame. */
  private attempt = 0;
  /** Inspection captured at the submit of the last successful attempt; any new attempt clears it. */
  private lastFrame?: FrameInspection;
  private constructor(
    readonly device: GPUDevice,
    private context: GPUCanvasContext,
    readonly project: Project,
    readonly resolution: readonly [number, number],
    readonly format: GPUTextureFormat,
    private readonly inspectionEnabled: boolean,
  ) {}
  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    project: Project,
    onError: (message: string) => void = () => {},
    signal?: AbortSignal,
    /** Opt in to per-frame inspection capture; ordinary rendering never reads scene inspection. */
    inspection = false,
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
      inspection,
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
    const attempt = this.beginAttempt();
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
    this.submitFrame(evaluation, attempt, time);
  }
  private deactivateOtherMedia(active: readonly Scene[]) {
    for (const scene of this.scenes.values())
      if (!active.includes(scene)) managedVideoScenes.get(scene)?.deactivate();
  }
  async renderAsync(time: number, signal?: AbortSignal) {
    if (this.disposed) throw Error("Renderer is disposed.");
    const attempt = this.beginAttempt();
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
          ...(this.inspectionEnabled ? { inspection: true } : {}),
        });
      }
      this.assertCurrentFrame(generation, controller.signal);
      await this.overlay?.prepareFrame?.({
        ...this.overlayTiming(evaluation.primary.time),
        signal: controller.signal,
        ...(this.inspectionEnabled ? { inspection: true } : {}),
      });
      this.assertCurrentFrame(generation, controller.signal);
      this.submitFrame(evaluation, attempt, time);
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
  /** Snapshot of the last successful frame; throws while no submitted frame is available. */
  inspectFrame(): FrameInspection {
    if (this.disposed) throw Error("Renderer is disposed.");
    if (!this.inspectionEnabled)
      throw Error(
        "Frame inspection is disabled. Create the renderer with inspection enabled to capture frames.",
      );
    if (!this.lastFrame)
      throw Error(
        "No successful frame is available for inspection. Render a frame first; a newer, failed or cancelled attempt does not keep the previous frame.",
      );
    return this.lastFrame;
  }
  /** Every render attempt invalidates the snapshot and claims publication ownership. */
  private beginAttempt() {
    this.lastFrame = undefined;
    return ++this.attempt;
  }
  /** Read inspection metadata of one submitted frame. The returned object is referenced, not
   * copied, so a provider must return a frame it does not mutate after submission.
   */
  private captureFrame(
    evaluation: ReturnType<typeof evaluateActive>,
    requestedTime: number,
    transitionDraw: TransitionDraw,
  ): FrameInspection {
    const scenes = evaluation.active.map((active): InspectedScene => ({
      id: active.entry.id,
      name: active.entry.name,
      time: active.time,
      localTime: active.localTime,
      progress: active.progress,
      ...readLayer(this.scenes.get(active.entry.id), active.entry.name),
    }));
    return {
      requestedTime,
      effectiveTime: evaluation.primary.time,
      scenes,
      overlay: this.overlay && {
        ...this.overlayTiming(evaluation.primary.time),
        ...readLayer(this.overlay, "Project overlay"),
      },
      transitionDraw,
    };
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
  private submitFrame(
    evaluation: ReturnType<typeof evaluateActive>,
    attempt: number,
    requestedTime: number,
  ) {
    let transitionDraw: TransitionDraw | undefined;
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
                .sharedElements?.({
                  ...context,
                  ...evaluation.active[0],
                  ...(this.inspectionEnabled ? { inspection: true } : {}),
                }) ?? [],
              this.scenes
                .get(evaluation.active[1].entry.id)!
                .sharedElements?.({
                  ...context,
                  ...evaluation.active[1],
                  ...(this.inspectionEnabled ? { inspection: true } : {}),
                }) ?? [],
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
          ...(this.inspectionEnabled ? { inspection: true } : {}),
        });
      });
      const uploaded = this.transition.render(
        { ...context, ...evaluation.primary },
        evaluation.transition,
      );
      // Copy only while inspection is on. The upload array itself is the draw's one allocation.
      if (this.inspectionEnabled)
        transitionDraw = transitionDrawFrom(
          evaluation.transition.type,
          uploaded,
          this.resolution,
          evaluation.active,
        );
    } else {
      this.scenes.get(evaluation.primary.entry.id)!.render({
        ...context,
        ...evaluation.primary,
        ...(this.inspectionEnabled ? { inspection: true } : {}),
      });
      if (this.inspectionEnabled)
        transitionDraw = {
          kind: "direct",
          output: [this.resolution[0], this.resolution[1]],
        };
    }
    this.overlay?.render({
      ...context,
      ...this.overlayTiming(evaluation.primary.time),
      ...(this.inspectionEnabled ? { inspection: true } : {}),
    });
    this.device.queue.submit([encoder.finish()]);
    // Capture at this frame's submit so a later preparation or scene swap cannot rewrite it. An
    // older attempt still completes (queued work stays ordered) but must not publish over a newer
    // one. The captured frame references the provider's object, so providers must not mutate it.
    if (this.inspectionEnabled && attempt === this.attempt && transitionDraw)
      this.lastFrame = this.captureFrame(
        evaluation,
        requestedTime,
        transitionDraw,
      );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderGeneration++;
    this.lastFrame = undefined;
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
