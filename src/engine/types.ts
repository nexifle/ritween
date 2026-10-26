/** All times are seconds. Instances belong to one renderer; never share GPU state. */
export interface SetupContext {
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
}
export interface Scene {
  setup(context: SetupContext): void | Promise<void>;
  /** Pure timeline evaluation: do not integrate deltas or depend on previous frames. */
  render(context: RenderContext): void;
  dispose(): void;
}
export interface SceneEntry {
  id: string;
  name: string;
  source: string;
  start: number;
  duration: number;
  create: () => Scene;
  transition: { type: "cut" };
}
/** Clip-local time maps through `at`. Context time 0 is composition time 0. */
export interface AudioHost {
  context: BaseAudioContext;
  destination: AudioNode;
  start: number;
  duration: number;
  at(localTime: number): number;
}
export interface AudioClipSource {
  schedule(host: AudioHost): void | Promise<void>;
}
export interface AudioClip {
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
export interface Project {
  name: string;
  resolution: readonly [number, number];
  aspectRatio: readonly [number, number];
  duration: number;
  scenes: readonly SceneEntry[];
  /** Separate from scenes. Omitted tracks mean a silent picture. */
  audioTracks?: readonly AudioTrack[];
}
/** Extension point: future compositors can evaluate multiple active scene textures. */
export interface Compositor {
  render(context: RenderContext, active: readonly Scene[]): void;
}
