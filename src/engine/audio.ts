import {
  audibleAudioTracks,
  mutedAudioClipIds,
  mutedAudioTrackIds,
} from "./project-settings";
import { LiveMix, prepareOfflineAudio, AUDIO_LIMITS } from "./live-mix";
import { resolveMediaProject } from "./media/project";
import { frameCount, validateProject } from "./timeline";
import type { Project } from "./types";

/** 24, 30, and 60 all divide this, so audio length matches an exact frame count. */
export const SAMPLE_RATE = 48_000;
export const PREVIEW_VOLUME_DB = -18;
// Retain at most one successful mix per project. Weak ownership lets HMR and
// closed projects release PCM; switching mute settings replaces the old mix.
const exportMixes = new WeakMap<
  Project,
  { key: string; buffer: AudioBuffer }
>();

export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (gain: number) =>
  gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;

export function audioSampleCount(duration: number, fps: number) {
  if (!Number.isInteger(fps) || fps <= 0 || SAMPLE_RATE % fps !== 0)
    throw Error("Audio sample rate must divide evenly by FPS.");
  return frameCount(duration, fps) * (SAMPLE_RATE / fps);
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
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  project = resolveMediaProject(project);
  validateProject(project);
  const mutedClips = mutedAudioClipIds(project);
  const key = JSON.stringify([
    fps,
    project.duration,
    [...new Set([...mutedAudioTrackIds(project), ...mutedTrackIds])].sort(),
    [...mutedClips].sort(),
  ]);
  const cached = exportMixes.get(project);
  if (cached?.key === key) return cached.buffer;
  const tracks = audibleAudioTracks(project, mutedTrackIds);
  const mutedClipIds = new Set(mutedClips);
  if (
    !tracks.some((track) =>
      track.clips.some((clip) => !mutedClipIds.has(clip.id)),
    )
  )
    return null;
  if (typeof OfflineAudioContext === "undefined")
    throw Error(
      "OfflineAudioContext is unavailable. Use a current Chrome or Edge browser.",
    );
  const length = audioSampleCount(project.duration, fps);
  if (length * 2 * 4 > AUDIO_LIMITS.mixBufferBytes)
    throw Error(
      "Audio mix exceeds the 256 MiB PCM limit. Split the composition.",
    );
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
  const deferred = await prepareOfflineAudio(
    ctx,
    master,
    project,
    mutedTrackIds,
    signal,
    [...mutedClipIds],
  );
  signal?.throwIfAborted();
  // Populate independent voices just before they are needed. Shared buses and
  // effects stay connected throughout, preserving their state and tails.
  deferred.sort((a, b) => a.time - b.time);
  let next = 0;
  const populate = (until: number) => {
    signal?.throwIfAborted();
    while (next < deferred.length && deferred[next].time <= until)
      deferred[next++].schedule();
  };
  populate(0.5);
  const duration = ctx.length / SAMPLE_RATE;
  // Register each suspension before resuming so fast offline rendering cannot
  // overrun the next lookahead window. Do not suspend at/after the final sample.
  const advance = (at: number): Promise<void> => {
    if (next >= deferred.length || at >= duration) return Promise.resolve();
    return ctx.suspend(at).then(async () => {
      populate(ctx.currentTime + 0.5);
      const upcoming = advance(at + 0.25);
      // Observe future errors immediately, including while resume is pending.
      await Promise.all([ctx.resume(), upcoming]);
    });
  };
  const windows = advance(0.25);
  let rendered: AudioBuffer;
  try {
    [rendered] = await Promise.all([ctx.startRendering(), windows]);
  } catch (error) {
    // Offline contexts have no close(). Remove the audible graph and resume a
    // failed/suspended render so its native resources can finish and be released.
    master.disconnect();
    limiter.disconnect();
    void ctx.resume().catch(() => {});
    throw error;
  }
  signal?.throwIfAborted();
  exportMixes.set(project, { key, buffer: rendered });
  return rendered;
}

/**
 * Lookahead preview. Prepare while opening the project; playback only resumes
 * the context and arms the prepared score. The picture follows the audio clock.
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
  private disposed = false;
  private resuming: Promise<void> | null = null;
  private suspension: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private mutedTrackIds: readonly string[] = [];
  private mutedClipIds: readonly string[] = [];

  private createContext() {
    if (this.disposed) throw Error("Preview audio is disposed.");
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
  }

  /** No resume here: assets/score can be prepared before the first gesture. */
  async prepare(project: Project) {
    project = resolveMediaProject(project);
    if (!(project.audioTracks ?? []).some((track) => track.clips.length))
      return false;
    this.createContext();
    // Also suspend on browsers that allow autoplay, avoiding idle device work.
    if (!this.playing && this.ctx!.state === "running") this.suspend();
    return this.mix!.prepare(project, this.mutedTrackIds, this.mutedClipIds);
  }

  unlock() {
    clearTimeout(this.idleTimer);
    this.createContext();
    if (this.suspension || this.ctx!.state !== "running") {
      this.resuming = this.ctx!.resume();
      // Gesture handlers do not await this. play() observes the same promise.
      void this.resuming.catch(() => {});
    }
  }

  setMuted(trackIds: readonly string[], clipIds: readonly string[] = []) {
    this.mutedTrackIds = [...trackIds];
    this.mutedClipIds = [...clipIds];
    return (this.mix?.setMuted(trackIds, clipIds) ?? Promise.resolve()).then(
      () => {
        if (
          this.playing &&
          !this.blocking &&
          !this.armed &&
          this.mix?.audible
        ) {
          this.mix.start(this.pendingOffset);
          this.armed = true;
        }
      },
    );
  }

  setMonitor(volumeDb: number, masterMuted: boolean) {
    this.volumeDb = volumeDb;
    this.masterMuted = masterMuted;
    this.applyMonitor(false);
  }

  /** True while preparation or context resume is pending. The picture holds. */
  isBlocking() {
    return this.blocking;
  }

  /** Composition seconds currently heard, or null when the picture clock should coast. */
  heardTime() {
    if (!this.armed || !this.playing || !this.ctx || !this.mix) return null;
    const delay = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return this.mix.heard(delay);
  }

  async play(
    from: number,
    project: Project,
    mutedTrackIds: readonly string[],
    mutedClipIds: readonly string[] = [],
  ) {
    project = resolveMediaProject(project);
    if (!(project.audioTracks ?? []).some((track) => track.clips.length)) {
      this.stop();
      return;
    }
    this.unlock();
    const generation = ++this.generation;
    this.playing = true;
    this.pendingOffset = from;
    this.blocking = true;
    this.armed = false;
    let audible: boolean;
    try {
      [audible] = await Promise.all([
        this.mix!.prepare(project, mutedTrackIds, mutedClipIds),
        this.resuming,
      ]);
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
    if (!this.playing || generation !== this.generation) return;
    this.blocking = false;
    audible ||= this.mix!.audible;
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
    clearTimeout(this.idleTimer);
    if (!this.disposed && this.ctx) {
      this.idleTimer = setTimeout(() => {
        if (!this.playing && this.ctx?.state === "running") this.suspend();
      }, 3000);
    }
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.mix?.dispose();
    this.mix = null;
    void this.ctx?.close();
    this.ctx = null;
    this.monitor = null;
  }

  private suspend() {
    const pending = this.ctx!.suspend();
    this.suspension = pending;
    void pending
      .catch(() => {})
      .finally(() => {
        if (this.suspension === pending) this.suspension = null;
      });
  }

  private applyMonitor(immediate: boolean) {
    if (!this.ctx || !this.monitor) return;
    const gain = this.masterMuted ? 0 : dbToGain(this.volumeDb);
    if (immediate) this.monitor.gain.value = gain;
    else this.monitor.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }
}
