import type {
  FramePreparationContext,
  MediaClip,
  SetupContext,
} from "../engine/types";
import {
  loadImageTexture,
  loadVideoTexture,
  type ImageTexture,
  type VideoTexture,
} from "../engine/render/visual";
import type { EvaluatedFrame } from "./layout";
import type { MediaSpec } from "./media";

export function mediaKey(source: MediaSpec): string {
  return source.kind === "image"
    ? JSON.stringify(["image", source.url])
    : JSON.stringify([
        "video",
        source.clip.id,
        source.clip.url,
        source.clip.start,
        source.clip.duration,
        source.clip.offset ?? 0,
        source.clip.muted ?? false,
        source.clip.volume ?? 1,
      ]);
}
export function frameMedia(
  frame: EvaluatedFrame,
): Extract<EvaluatedFrame["commands"][number], { kind: "media" }>[] {
  return frame.commands.flatMap((c) =>
    c.kind === "media"
      ? [c]
      : c.kind === "composition" || c.kind === "group"
        ? [
            ...(c.kind === "composition" && c.imageMask
              ? [
                  {
                    kind: "media" as const,
                    path: `${c.path}/mask`,
                    bounds: c.bounds,
                    transform: c.transform,
                    opacity: 1,
                    time: 0,
                    source: {
                      kind: "image" as const,
                      url: c.imageMask.url,
                      style: { width: c.bounds.width, height: c.bounds.height },
                    },
                  },
                ]
              : []),
            ...frameMedia(c.frame),
            ...(c.overlay ? frameMedia(c.overlay) : []),
          ]
        : [],
  );
}

/** Each Stage owns its media. Immutable nodes never own textures or decoders. */
export class ViewMedia {
  readonly resources = new Map<string, ImageTexture | VideoTexture>();
  private lifetime = new AbortController();
  private activation = new AbortController();
  private videos = new Set<string>();
  constructor(
    private context: SetupContext,
    private clips: readonly MediaClip[],
    readonly activeOnly: boolean,
    private loaders = { image: loadImageTexture, video: loadVideoTexture },
  ) {}
  async setup(frame: EvaluatedFrame, images: readonly string[] = []) {
    const sources: MediaSpec[] = [
      ...frameMedia(frame).map((c) => c.source),
      ...images.map((url) => ({
        kind: "image" as const,
        url,
        style: { width: 1, height: 1 },
      })),
    ];
    if (!this.activeOnly)
      sources.push(
        ...this.clips.map((clip) => ({
          kind: "video" as const,
          clip,
          style: { width: 1, height: 1 },
        })),
      );
    try {
      for (const source of sources)
        if (source.kind === "video") this.assertClip(source);
      for (const source of sources)
        if (source.kind === "image" || !this.activeOnly)
          await this.load(source);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private assertClip(source: Extract<MediaSpec, { kind: "video" }>) {
    const key = mediaKey(source);
    if (!this.clips.some((clip) => mediaKey({ ...source, clip }) === key))
      throw Error(
        `Video ${source.clip.id} must use a clip declared in Stage/Shot.mediaClips (or Stage options for an Overlay).`,
      );
  }
  private async load(
    source: MediaSpec,
    signal?: AbortSignal,
  ): Promise<ImageTexture | VideoTexture> {
    const key = mediaKey(source);
    const combined = AbortSignal.any([
      this.lifetime.signal,
      this.activation.signal,
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    const existing = this.resources.get(key);
    if (existing) return existing;
    if (source.kind === "video") this.assertClip(source);
    const resource =
      source.kind === "image"
        ? await this.loaders.image(this.context, {
            url: source.url,
            signal: combined,
          })
        : await this.loaders.video(this.context, source.clip, combined);
    if (combined.aborted) {
      resource.dispose();
      combined.throwIfAborted();
    }
    this.resources.set(key, resource);
    if (source.kind === "video") this.videos.add(key);
    return resource;
  }
  async prepare(frame: EvaluatedFrame, timing: FramePreparationContext) {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.activation.signal,
      ...(timing.signal ? [timing.signal] : []),
    ]);
    signal.throwIfAborted();
    const commands = frameMedia(frame);
    const used = new Set(commands.map((c) => mediaKey(c.source)));
    for (const [key, resource] of this.resources)
      if (!used.has(key) && (!this.videos.has(key) || this.activeOnly)) {
        resource.dispose();
        this.resources.delete(key);
        this.videos.delete(key);
      }
    const prepared = new Set<string>();
    try {
      for (const command of commands) {
        const key = mediaKey(command.source);
        if (prepared.has(key)) continue;
        prepared.add(key);
        try {
          const resource = await this.load(command.source, timing.signal);
          if ("prepareFrame" in resource)
            await resource.prepareFrame({ time: command.time, signal });
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) signal.throwIfAborted();
          throw Error(
            `${command.path}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
    } catch (error) {
      if (this.activeOnly) this.deactivate();
      throw error;
    }
  }
  deactivate() {
    this.activation.abort();
    this.activation = new AbortController();
    for (const key of this.videos) {
      this.resources.get(key)?.dispose();
      this.resources.delete(key);
    }
    this.videos.clear();
  }
  dispose() {
    this.lifetime.abort();
    this.deactivate();
    for (const resource of this.resources.values()) resource.dispose();
    this.resources.clear();
  }
}
