import { LiveMix } from "./live-mix";
import { frameCount, validateProject } from "./timeline";
import type { Project } from "./types";

/** 24, 30, and 60 all divide this, so audio length matches an exact frame count. */
export const SAMPLE_RATE = 48_000;
export const PREVIEW_VOLUME_DB = -18;
const CLIP_RAMP_SECONDS = 0.005;

export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (gain: number) =>
  gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;

export function audioSampleCount(duration: number, fps: number) {
  if (!Number.isInteger(fps) || fps <= 0 || SAMPLE_RATE % fps !== 0)
    throw Error("Audio sample rate must divide evenly by FPS.");
  return frameCount(duration, fps) * (SAMPLE_RATE / fps);
}

/** Opens and closes a clip bus. Short clips split the ramp instead of overlapping it. */
export function windowClip(param: AudioParam, start: number, duration: number) {
  const ramp = Math.min(CLIP_RAMP_SECONDS, duration / 2);
  const end = start + duration;
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(1, start + ramp);
  if (end - ramp > start + ramp) param.setValueAtTime(1, end - ramp);
  param.linearRampToValueAtTime(0, end);
}

/**
 * Full offline mix used by export. Muted tracks are left out of the buffer.
 * Returns null when the composition has nothing audible.
 * Preview does not call this. It keeps a lookahead of live nodes instead.
 */
export async function renderAudio(
  project: Project,
  mutedTrackIds: readonly string[],
  fps: number,
) {
  validateProject(project);
  const muted = new Set(mutedTrackIds);
  const tracks = (project.audioTracks ?? []).filter(
    (track) => !muted.has(track.id) && track.clips.length > 0,
  );
  if (!tracks.length) return null;
  if (typeof OfflineAudioContext === "undefined")
    throw Error(
      "OfflineAudioContext is unavailable. Use a current Chrome or Edge browser.",
    );
  const length = audioSampleCount(project.duration, fps);
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const master = new GainNode(ctx, { gain: 1 });
  const limiter = new DynamicsCompressorNode(ctx, {
    threshold: -1,
    knee: 0,
    ratio: 20,
    attack: 0.002,
    release: 0.12,
  });
  master.connect(limiter).connect(ctx.destination);
  for (const track of tracks) {
    for (const clip of track.clips) {
      const bus = new GainNode(ctx, { gain: 0 });
      bus.connect(master);
      windowClip(bus.gain, clip.start, clip.duration);
      const source = clip.create();
      await source.schedule({
        context: ctx,
        destination: bus,
        start: clip.start,
        duration: clip.duration,
        at: (localTime) => clip.start + localTime,
      });
    }
  }
  return ctx.startRendering();
}

/**
 * Lookahead preview. The picture waits while the score is recorded, then
 * follows the audio clock. Export does not use this class.
 * `unlock` must run inside the user gesture, before any await.
 */
export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private monitor: GainNode | null = null;
  private mix: LiveMix | null = null;
  private volumeDb = PREVIEW_VOLUME_DB;
  private masterMuted = false;
  private playing = false;
  private armed = false;
  private blocking = false;
  private pendingOffset = 0;
  private generation = 0;

  unlock() {
    const Ctx =
      window.AudioContext ??
      (
        window as unknown as {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!Ctx) throw Error("AudioContext is unavailable in this browser.");
    if (!this.ctx) {
      this.ctx = new Ctx({
        sampleRate: SAMPLE_RATE,
        latencyHint: "interactive",
      });
      this.monitor = new GainNode(this.ctx, { gain: 0 });
      this.monitor.connect(this.ctx.destination);
      this.mix = new LiveMix(this.ctx, this.monitor);
      this.applyMonitor(true);
    }
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  setMonitor(volumeDb: number, masterMuted: boolean) {
    this.volumeDb = volumeDb;
    this.masterMuted = masterMuted;
    this.applyMonitor(false);
  }

  /** True while the score is still being recorded. The picture should hold. */
  isBlocking() {
    return this.blocking;
  }

  /** Composition seconds currently heard, or null when the picture clock should coast. */
  heardTime() {
    if (!this.armed || !this.playing || !this.ctx || !this.mix) return null;
    const delay = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return this.mix.heard(delay);
  }

  async play(from: number, project: Project, mutedTrackIds: readonly string[]) {
    this.unlock();
    const generation = ++this.generation;
    this.playing = true;
    this.pendingOffset = from;
    this.blocking = true;
    this.armed = false;
    const audible = await this.mix!.prepare(project, mutedTrackIds);
    if (!this.playing || generation !== this.generation) return;
    this.blocking = false;
    if (!audible) return;
    this.mix!.start(this.pendingOffset);
    this.armed = true;
  }

  seek(time: number) {
    if (!this.playing) return;
    this.pendingOffset = time;
    if (this.armed) this.mix?.seek(time);
  }

  stop() {
    this.generation++;
    this.playing = false;
    this.armed = false;
    this.blocking = false;
    this.mix?.stop();
  }

  dispose() {
    this.stop();
    this.mix?.dispose();
    this.mix = null;
    void this.ctx?.close();
    this.ctx = null;
    this.monitor = null;
  }

  private applyMonitor(immediate: boolean) {
    if (!this.ctx || !this.monitor) return;
    const gain = this.masterMuted ? 0 : dbToGain(this.volumeDb);
    if (immediate) this.monitor.gain.value = gain;
    else this.monitor.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }
}
