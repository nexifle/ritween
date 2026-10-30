/** All times are seconds. Instances belong to one renderer; never share GPU state. */
export interface SetupContext {
  compositionResolution?: readonly [number, number];
  device: GPUDevice;
  format: GPUTextureFormat;
  resolution: readonly [number, number];
}
export interface RenderContext extends SetupContext {
  target: GPUTexture;
  encoder: GPUCommandEncoder;
  time: number;
  localTime: number;
  progress: number;
  /** Output-pixel affine corrections for matched authoring elements. */
  sharedTransforms?: ReadonlyMap<string, readonly number[]>;
  /** Internal local-render-target to output mapping for nested shared elements. */
  sharedSpace?: readonly number[];
}
export interface FramePreparationContext {
  time: number;
  localTime: number;
  progress: number;
  signal?: AbortSignal;
}
export interface Scene {
  setup(context: SetupContext): void | Promise<void>;
  prepareFrame?(context: FramePreparationContext): void | Promise<void>;
  /** Pure timeline evaluation: do not integrate deltas or depend on previous frames. */
  render(context: RenderContext): void;
  /** Optional deterministic screen-space element poses, evaluated before rendering. */
  sharedElements?(context: RenderContext): readonly SharedElement[];
  dispose(): void;
}
export interface MediaClip {
  id: string;
  name: string;
  url: string;
  start: number;
  duration: number;
  offset?: number;
  muted?: boolean;
  volume?: number;
}
export interface SharedElement {
  readonly id: string;
  /** Unit rectangle to output pixels: [a, b, c, d, e, f]. */
  readonly matrix: readonly number[];
}
export type Transition =
  | { readonly type: "cut" }
  | {
      readonly type:
        "crossfade" | "wipe" | "slide" | "zoom" | "shared" | "custom";
      readonly duration: number;
      /** Custom WGSL defining fn transition(uv: vec2f, progress: f32) -> vec4f. */
      readonly shader?: string;
      /** Scene-linked audio fades by default; false preserves its original envelope. */
      readonly audioCrossfade?: boolean;
      readonly direction?: "left" | "right" | "up" | "down";
    };
export interface SceneEntry {
  mediaClips?: readonly MediaClip[];
  id: string;
  name: string;
  source: string;
  start: number;
  duration: number;
  create: () => Scene;
  /** Incoming transition: overlaps the end of the preceding scene. */
  transition: Transition;
}
/** Clip-local time maps through `at`. Context time 0 is composition time 0. */
export interface AudioHost {
  signal?: AbortSignal;
  context: BaseAudioContext;
  destination: AudioNode;
  start: number;
  duration: number;
  at(localTime: number): number;
}
export interface AudioClipSource {
  schedule(host: AudioHost): void | Promise<void>;
  /** Release source-owned caches after scheduling ends, including error/cancel. */
  dispose?(): void;
}
export interface AudioClip {
  /** Link to a scene to follow its incoming/outgoing transition audio envelope. */
  sceneId?: string;
  muted?: boolean;
  id: string;
  name: string;
  start: number;
  duration: number;
  create: () => AudioClipSource;
}
export interface AudioTrack {
  id: string;
  name: string;
  clips: readonly AudioClip[];
}
export interface AudioTrackSettings {
  muted?: boolean;
}
/** Versioned, serializable entity settings. IDs remain stable when tracks move. */
export interface ProjectExportSettings {
  resolution?: readonly [number, number];
  fps?: 24 | 30 | 60;
  bitrate?: number | "auto";
  latencyMode?: "quality" | "realtime";
  keyFrameInterval?: number;
}
export interface ProjectSettings {
  export?: ProjectExportSettings;
  version: 1;
  audioTracks?: Readonly<Record<string, AudioTrackSettings>>;
  audioClips?: Readonly<Record<string, AudioTrackSettings>>;
}
export interface Project {
  mediaClips?: readonly MediaClip[];
  settings?: ProjectSettings;
  name: string;
  resolution: readonly [number, number];
  aspectRatio: readonly [number, number];
  duration: number;
  scenes: readonly SceneEntry[];
  /** Persistent screen-space layer, rendered after scene transitions. Must preserve target contents.
   * Owns one Scene per renderer. localTime equals project time; progress spans the project.
   */
  overlay?: () => Scene;
  /** Separate from scenes. Omitted tracks mean a silent picture. */
  audioTracks?: readonly AudioTrack[];
}
/** Extension point: future compositors can evaluate multiple active scene textures. */
export interface Compositor {
  render(context: RenderContext, active: readonly Scene[]): void;
}
