import { frameCount, validateProject } from "./timeline";
import type { Project } from "./types";

/** 24, 30, and 60 all divide this, so audio length matches an exact frame count. */
export const SAMPLE_RATE = 48_000;
export const PREVIEW_VOLUME_DB = -18;
const CLIP_RAMP_SECONDS = 0.005;
const STOP_RAMP_SECONDS = 0.01;
const START_LEAD_SECONDS = 0.02;

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
 * One mix for preview and export. Muted tracks are left out of the buffer.
 * Returns null when the composition has nothing audible.
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
 * Plays a rendered buffer. The graph is never built here.
 * `unlock` must run inside the user gesture, before any await.
 */
export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private monitor: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private fade: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private bufferKey = "";
  private volumeDb = PREVIEW_VOLUME_DB;
  private masterMuted = false;
  private playing = false;
  private armed = false;
  private origin = 0;
  private hold = 0;
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
      this.applyMonitor(true);
    }
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  setMonitor(volumeDb: number, masterMuted: boolean) {
    this.volumeDb = volumeDb;
    this.masterMuted = masterMuted;
    this.applyMonitor(false);
  }

  /** Composition seconds currently heard, or null while the picture clock should coast. */
  heardTime() {
    if (!this.armed || !this.playing || !this.ctx) return null;
    const delay = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return Math.max(this.hold, this.ctx.currentTime - this.origin - delay);
  }

  async play(
    from: number,
    project: Project,
    mutedTrackIds: readonly string[],
    fps = 30,
  ) {
    this.unlock();
    const generation = ++this.generation;
    this.playing = true;
    this.pendingOffset = from;
    await this.ensureBuffer(project, mutedTrackIds, fps, generation);
    if (!this.playing || generation !== this.generation) return;
    if (!this.buffer) {
      this.halt();
      this.armed = false;
      return;
    }
    this.startSource(this.pendingOffset);
  }

  seek(time: number) {
    if (!this.playing) return;
    this.pendingOffset = time;
    if (this.buffer) this.startSource(time);
  }

  stop() {
    this.generation++;
    this.playing = false;
    this.armed = false;
    this.halt();
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.monitor = null;
    this.buffer = null;
  }

  private applyMonitor(immediate: boolean) {
    if (!this.ctx || !this.monitor) return;
    const gain = this.masterMuted ? 0 : dbToGain(this.volumeDb);
    if (immediate) this.monitor.gain.value = gain;
    else this.monitor.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  private async ensureBuffer(
    project: Project,
    mutedTrackIds: readonly string[],
    fps: number,
    generation: number,
  ) {
    const key = `${fps}:${[...mutedTrackIds].sort().join("\0")}`;
    if (this.buffer && this.bufferKey === key) return;
    this.buffer = null;
    this.bufferKey = key;
    const buffer = await renderAudio(project, mutedTrackIds, fps);
    if (generation !== this.generation || this.bufferKey !== key) return;
    this.buffer = buffer;
  }

  private startSource(offset: number) {
    if (!this.ctx || !this.monitor || !this.buffer) return;
    this.halt();
    const offsetClamped = Math.min(
      Math.max(0, offset),
      Math.max(0, this.buffer.duration - 1 / SAMPLE_RATE),
    );
    const fade = new GainNode(this.ctx, { gain: 1 });
    const source = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer });
    source.connect(fade).connect(this.monitor);
    const when = this.ctx.currentTime + START_LEAD_SECONDS;
    source.start(when, offsetClamped);
    source.onended = () => {
      source.disconnect();
      fade.disconnect();
    };
    this.source = source;
    this.fade = fade;
    this.origin = when - offsetClamped;
    this.hold = offsetClamped;
    this.armed = true;
  }

  private halt() {
    const source = this.source;
    const fade = this.fade;
    this.source = null;
    this.fade = null;
    if (!source || !this.ctx || !fade) return;
    const now = this.ctx.currentTime;
    try {
      fade.gain.cancelScheduledValues(now);
      fade.gain.setValueAtTime(fade.gain.value, now);
      fade.gain.linearRampToValueAtTime(0, now + STOP_RAMP_SECONDS);
      source.stop(now + STOP_RAMP_SECONDS + 0.002);
    } catch {
      source.disconnect();
      fade.disconnect();
    }
  }
}
