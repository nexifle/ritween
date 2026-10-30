import type {
  FramePreparationContext,
  MediaClip,
  RenderContext,
  Scene,
  SetupContext,
} from "../engine/types";
import { managedVideoScenes, videoResource } from "../engine/render/visual";
import { ViewMedia, frameMedia } from "./media-runtime";
import {
  defaultTheme,
  evaluateView,
  type EvaluatedFrame,
  type Theme,
} from "./layout";
import type { ViewNode } from "./nodes";
import { collectSharedElements } from "./shared-elements";
import { ViewRenderer } from "./renderer";
import { Camera, evaluateCamera, type CameraOptions } from "./camera";

export interface StageContext {
  /** Composition time and scene-local time, both in seconds. */
  readonly time: number;
  readonly localTime: number;
  readonly progress: number;
  readonly resolution: readonly [number, number];
  readonly designSize: readonly [number, number];
  readonly theme: Theme;
}
export interface StageOptions {
  /** Project-clock clips, shared with SceneEntry.mediaClips for footage audio. */
  readonly mediaClips?: readonly MediaClip[];
  /** Optional image preloads; images appearing later are discovered during frame preparation. */
  readonly images?: readonly string[];
  readonly designSize?: readonly [number, number];
  readonly theme?: Theme;
  readonly background?: string;
  readonly debugBounds?: boolean;
  /** Static/animated data, or a pure function for procedural paths and tracking. */
  readonly camera?: CameraOptions | ((context: StageContext) => CameraOptions);
  /** Text raster scale relative to output pixels; raise for close camera shots. */
  readonly textResolution?: number;
}
export interface StageScene extends Scene {
  /** Last rendered layout and display list; no GPU readback required. */
  inspect(): EvaluatedFrame | undefined;
}

/** Pure view factory adapted to the existing scene lifecycle; no second timeline. */
export function Stage(
  view: (context: StageContext) => ViewNode,
  options: StageOptions = {},
): StageScene {
  return createViewScene(view, options, true);
}

export type OverlayOptions = Omit<StageOptions, "camera" | "background">;

/** Persistent project layer: no camera, no clear, and no scene transition transform. */
export function Overlay(
  view: (context: StageContext) => ViewNode,
  options: OverlayOptions = {},
): StageScene {
  return createViewScene(
    view,
    {
      designSize: options.designSize,
      theme: options.theme,
      debugBounds: options.debugBounds,
      textResolution: options.textResolution,
      mediaClips: options.mediaClips,
      images: options.images,
    },
    false,
  );
}

function createViewScene(
  view: (context: StageContext) => ViewNode,
  options: StageOptions,
  clear: boolean,
): StageScene {
  const designSize = options.designSize
    ? (Object.freeze([...options.designSize]) as readonly [number, number])
    : undefined;
  const sourceTheme = options.theme ?? defaultTheme;
  const theme: Theme = Object.freeze({
    ...sourceTheme,
    colors: Object.freeze({ ...sourceTheme.colors }),
  });
  const background = options.background ?? theme.colors.background ?? "#FFFFFF";
  const debug = options.debugBounds ?? false;
  const camera =
    typeof options.camera === "function"
      ? options.camera
      : options.camera
        ? Camera(options.camera)
        : undefined;
  const textResolution = options.textResolution ?? 1;
  if (!Number.isFinite(textResolution) || textResolution < 1)
    throw Error("Stage textResolution must be finite and at least 1.");
  const clips = Object.freeze((options.mediaClips ?? []).map(videoResource));
  const images = Object.freeze([...(options.images ?? [])]);
  if (images.some((url) => !url))
    throw Error("Stage image URLs must not be empty.");
  const activeOnly =
    (globalThis as typeof globalThis & { __ritweenMediaActivation?: string })
      .__ritweenMediaActivation === "active-only";
  let setupContext: SetupContext;
  let media: ViewMedia | undefined;
  let prepared:
    | { timing: FramePreparationContext; result: ReturnType<typeof evaluate> }
    | undefined;
  let renderer: ViewRenderer | undefined;
  let frame: EvaluatedFrame | undefined;
  let disposed = false;
  let initialized = false;
  let ready = false;
  function contextFor(
    context: SetupContext,
    timing = { time: 0, localTime: 0, progress: 0 },
  ): StageContext {
    const size =
      designSize ?? context.compositionResolution ?? context.resolution;
    if (!size.every((v) => Number.isFinite(v) && v > 0))
      throw Error("Stage design size must be positive and finite.");
    return {
      ...timing,
      resolution: context.resolution,
      designSize: size,
      theme,
    };
  }
  function evaluate(
    context: SetupContext & {
      time: number;
      localTime: number;
      progress: number;
    },
  ) {
    if (!ready || disposed || !renderer) throw Error("Stage is not ready.");
    const env = contextFor(context, context);
    const activeRenderer = renderer;
    const layout = evaluateView(view(env), {
      time: context.localTime,
      width: env.designSize[0],
      height: env.designSize[1],
      theme,
      context: env,
      measureText: (text, font, tracking) => {
        if (!document.fonts.check(font))
          throw Error(
            `Font is not ready: ${font}. Preload fonts used by time-dependent content before creating the renderer.`,
          );
        return activeRenderer.measureText(text, font, tracking);
      },
    });
    return {
      env,
      evaluated: camera
        ? {
            ...layout,
            camera: evaluateCamera(
              typeof camera === "function" ? camera(env) : camera,
              env.localTime,
              env.designSize,
            ),
          }
        : layout,
    };
  }
  function resultFor(context: RenderContext) {
    if (
      prepared &&
      prepared.timing.time === context.time &&
      prepared.timing.localTime === context.localTime &&
      prepared.timing.progress === context.progress
    )
      return prepared.result;
    throw Error("Stage frame is not prepared. Use renderAsync().");
  }
  const scene: StageScene = {
    async prepareFrame(timing) {
      prepared = undefined;
      timing.signal?.throwIfAborted();
      const result = evaluate({ ...setupContext, ...timing });
      if (!media && frameMedia(result.evaluated).length) {
        media = new ViewMedia(setupContext, clips, activeOnly);
      }
      await media?.prepare(result.evaluated, timing);
      if (disposed) throw Error("Stage was disposed during frame preparation.");
      timing.signal?.throwIfAborted();
      prepared = { timing: { ...timing }, result };
    },
    sharedElements(context) {
      const { env, evaluated } = resultFor(context);
      return collectSharedElements(
        evaluated,
        env.designSize,
        context.resolution,
      );
    },
    async setup(context: SetupContext) {
      if (initialized || disposed)
        throw Error("Stage has already been initialized or disposed.");
      initialized = true;
      setupContext = context;
      const env = contextFor(context);
      const root = view(env);
      const fonts = new Set<string>();
      // Discovery uses the same composition traversal as rendering, before fonts are loaded.
      evaluateView(root, {
        time: 0,
        width: env.designSize[0],
        height: env.designSize[1],
        theme,
        context: env,
        measureText: (_text, font) => {
          fonts.add(font);
          return 0;
        },
      });
      await Promise.all([...fonts].map((font) => document.fonts.load(font)));
      await document.fonts.ready;
      if (disposed) throw Error("Stage was disposed during setup.");
      const instance = new ViewRenderer();
      renderer = instance;
      try {
        await instance.setup(context);
        if (disposed) throw Error("Stage was disposed during setup.");
        ready = true;
        const initial = evaluate({
          ...context,
          time: 0,
          localTime: 0,
          progress: 0,
        });
        const sources = frameMedia(initial.evaluated);
        if (clips.length || images.length || sources.length) {
          media = new ViewMedia(context, clips, activeOnly);

          await media.setup(initial.evaluated, images);
          if (disposed) throw Error("Stage was disposed during media setup.");
        }
      } catch (error) {
        ready = false;
        media?.dispose();
        instance.dispose();
        throw error;
      }
    },
    render(context: RenderContext) {
      if (!ready || disposed || !renderer) throw Error("Stage is not ready.");
      const { env, evaluated } = resultFor(context);
      renderer.render(
        evaluated,
        context,
        env.designSize,
        background,
        debug,
        textResolution,
        clear,
        media?.resources,
      );
      frame = evaluated;
    },
    inspect: () => frame,
    dispose() {
      disposed = true;
      ready = false;
      prepared = undefined;
      media?.dispose();
      managedVideoScenes.delete(scene);
      renderer?.dispose();
      renderer = undefined;
      frame = undefined;
    },
  };
  if (activeOnly)
    managedVideoScenes.set(scene, {
      deactivate() {
        prepared = undefined;
        media?.deactivate();
      },
    });
  return scene;
}
