import type { Project } from "../types";
import { Renderer } from "./renderer";

export interface FrameSourceOptions {
  width: number;
  height: number;
  signal?: AbortSignal;
  onError?: (message: string) => void;
}

/** A reusable canvas for offline output. Consume each frame before rendering the next. */
export class FrameSource {
  private constructor(
    readonly canvas: OffscreenCanvas,
    private readonly renderer: Renderer,
    private readonly signal?: AbortSignal,
  ) {}

  static async create(project: Project, options: FrameSourceOptions) {
    options.signal?.throwIfAborted();
    const canvas = new OffscreenCanvas(options.width, options.height);
    const renderer = await Renderer.create(
      canvas,
      project,
      options.onError,
      options.signal,
    );
    return new FrameSource(canvas, renderer, options.signal);
  }

  async render(time: number) {
    this.signal?.throwIfAborted();
    await this.renderer.renderAsync(time, this.signal);
    await this.renderer.device.queue.onSubmittedWorkDone();
    this.signal?.throwIfAborted();
    return this.canvas;
  }

  dispose() {
    this.renderer.dispose();
  }
}
