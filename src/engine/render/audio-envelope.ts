import type { AudioClip, Project } from "../types";

/** Clip-to-scene association is explicit; a global music bed must not fade per shot. */
export function sceneAudioEnvelope(project: Project, clip: AudioClip) {
  if (!clip.sceneId) return undefined;
  const index = project.scenes.findIndex((s) => s.id === clip.sceneId);
  if (index < 0) throw Error(`Unknown audio scene: ${clip.sceneId}`);
  const scene = project.scenes[index],
    incoming = scene.transition;
  const next = project.scenes[index + 1];
  const outgoing = next?.transition;
  return {
    start: scene.start,
    end: scene.start + scene.duration,
    fadeIn:
      incoming.type !== "cut" && incoming.audioCrossfade !== false
        ? incoming.duration
        : 0,
    fadeOut:
      outgoing && outgoing.type !== "cut" && outgoing.audioCrossfade !== false
        ? outgoing.duration
        : 0,
  };
}
export type SceneAudioEnvelope = NonNullable<
  ReturnType<typeof sceneAudioEnvelope>
>;
export function sceneAudioGain(envelope: SceneAudioEnvelope, time: number) {
  if (time < envelope.start || time >= envelope.end) return 0;
  const enter = envelope.fadeIn
    ? Math.min(1, (time - envelope.start) / envelope.fadeIn)
    : 1;
  const exit = envelope.fadeOut
    ? Math.min(1, (envelope.end - time) / envelope.fadeOut)
    : 1;
  return Math.min(enter, exit);
}
