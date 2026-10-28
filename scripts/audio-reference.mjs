/** Opens and closes a clip bus without overlapping ramps on short clips. */
function windowClip(param, start, duration) {
  const ramp = Math.min(0.005, duration / 2);
  const end = start + duration;
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(1, start + ramp);
  if (end - ramp > start + ramp) param.setValueAtTime(1, end - ramp);
  param.linearRampToValueAtTime(0, end);
}

/** Test-only eager native renderer: deliberately bypasses managed graph compilation. */
export async function renderEagerAudio(project, mutedIds, fps) {
  const { audioSampleCount, SAMPLE_RATE } =
    await import("../src/engine/render/audio.ts");
  const muted = new Set(mutedIds);
  const tracks = (project.audioTracks ?? []).filter(
    (track) => !muted.has(track.id),
  );
  if (!tracks.some((track) => track.clips.length)) return null;
  const ctx = new OfflineAudioContext(
    2,
    audioSampleCount(project.duration, fps),
    SAMPLE_RATE,
  );
  const master = new GainNode(ctx, { gain: 1 });
  master
    .connect(
      new DynamicsCompressorNode(ctx, {
        threshold: -1,
        knee: 0,
        ratio: 20,
        attack: 0.002,
        release: 0.12,
      }),
    )
    .connect(ctx.destination);
  for (const track of tracks)
    for (const clip of track.clips) {
      const bus = new GainNode(ctx, { gain: 0 });
      bus.connect(master);
      windowClip(bus.gain, clip.start, clip.duration);
      await clip.create().schedule({
        context: ctx,
        destination: bus,
        start: clip.start,
        duration: clip.duration,
        at: (local) => clip.start + local,
      });
    }
  return ctx.startRendering();
}
