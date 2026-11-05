import type { Project } from "../types";
import { Renderer, type FrameInspection } from "./renderer";

export interface FrameSourceOptions {
  width: number;
  height: number;
  signal?: AbortSignal;
  onError?: (message: string) => void;
  /** Opt in to inspection metadata; offline output never captures frames by default. */
  inspect?: boolean;
}

/** A reusable canvas for offline output. Consume each frame before rendering the next. */
export class FrameSource {
  /** Monotonic owner of each render operation; an older operation cannot publish over a newer one. */
  private operation = 0;
  private published = false;
  private publishedInspection?: FrameInspection;
  private constructor(
    readonly canvas: OffscreenCanvas,
    private readonly renderer: Renderer,
    private readonly signal?: AbortSignal,
    private readonly inspect = false,
  ) {}

  static async create(project: Project, options: FrameSourceOptions) {
    options.signal?.throwIfAborted();
    const inspect = options.inspect ?? false;
    const canvas = new OffscreenCanvas(options.width, options.height);
    const renderer = await Renderer.create(
      canvas,
      project,
      options.onError,
      options.signal,
      inspect,
    );
    return new FrameSource(canvas, renderer, options.signal, inspect);
  }

  async render(time: number) {
    // Claim ownership and drop the previous candidate before the pre-abort check: an aborted
    // attempt publishes nothing, and a newer operation keeps the right to publish.
    const operation = ++this.operation;
    this.published = false;
    this.publishedInspection = undefined;
    this.signal?.throwIfAborted();
    await this.renderer.renderAsync(time, this.signal);
    // Keep withholding until the GPU work resolves and cancellation stays clear.
    await this.renderer.device.queue.onSubmittedWorkDone();
    this.signal?.throwIfAborted();
    if (operation !== this.operation)
      throw new DOMException(
        "Offline frame was superseded before GPU completion.",
        "AbortError",
      );
    this.published = true;
    if (this.inspect) this.publishedInspection = this.renderer.inspectFrame();
    return this.canvas;
  }

  /** Snapshot of the last offline frame whose GPU work and abort checks succeeded. */
  inspectFrame(): FrameInspection {
    if (!this.published)
      throw Error(
        "No completed offline frame is available for inspection. Await render() first; a failed, cancelled or superseded frame publishes nothing.",
      );
    if (!this.publishedInspection)
      throw Error(
        "Frame inspection is disabled. Create the FrameSource with inspect: true to capture frames.",
      );
    return this.publishedInspection;
  }

  dispose() {
    this.operation++;
    this.published = false;
    this.publishedInspection = undefined;
    this.renderer.dispose();
  }
}
