import type { MediaClip, Project } from "../types";
import { footageAudio } from "./audio-file";

const FOOTAGE_TRACK = "__ritween_footage__";

export function validateMediaClip(clip: MediaClip) {
  if (
    !clip.id ||
    !clip.name ||
    !clip.url ||
    !Number.isFinite(clip.start) ||
    clip.start < 0 ||
    !Number.isFinite(clip.duration) ||
    clip.duration <= 0 ||
    !Number.isFinite(clip.offset ?? 0) ||
    (clip.offset ?? 0) < 0 ||
    !Number.isFinite(clip.volume ?? 1) ||
    (clip.volume ?? 1) < 0 ||
    (clip.muted !== undefined && typeof clip.muted !== "boolean")
  )
    throw Error(`Invalid media clip: ${clip.id}`);
}

/** Bentuk audio footage terkait sekali, tanpa mengubah proyek sumber. */
export function resolveMediaProject(project: Project): Project {
  const clips = [
    ...(project.mediaClips ?? []),
    ...project.scenes.flatMap((scene) => scene.mediaClips ?? []),
  ];
  if (!clips.length) return project;
  const ids = new Set(
    (project.audioTracks ?? []).flatMap((t) => t.clips.map((c) => c.id)),
  );
  const unique = new Map<string, MediaClip>();
  for (const clip of clips) {
    validateMediaClip(clip);
    if (clip.start + clip.duration > project.duration + 1e-8)
      throw Error(`Media clip exceeds project duration: ${clip.id}`);
    const previous = unique.get(clip.id);
    if (previous) {
      if (previous !== clip) throw Error(`Duplicate media clip: ${clip.id}`);
      continue;
    }
    if (ids.has(clip.id)) throw Error(`Duplicate audio/media clip: ${clip.id}`);
    ids.add(clip.id);
    unique.set(clip.id, clip);
  }
  const tracks = [...(project.audioTracks ?? [])];
  for (const clip of unique.values()) {
    const trackId = `${FOOTAGE_TRACK}${clip.id}`;
    if (tracks.some((track) => track.id === trackId))
      throw Error(`Reserved footage track ID: ${trackId}`);
    tracks.push({
      id: trackId,
      name: `${clip.name} · Footage`,
      clips: [
        {
          id: clip.id,
          name: clip.name,
          start: clip.start,
          duration: clip.duration,
          muted: clip.muted,
          create: footageAudio({
            url: clip.url,
            offset: clip.offset,
            volume: clip.volume,
          }),
        },
      ],
    });
  }
  const result = {
    ...project,
    mediaClips: undefined,
    scenes: project.scenes.map((scene) =>
      scene.mediaClips ? { ...scene, mediaClips: undefined } : scene,
    ),
    audioTracks: tracks,
  };
  return result;
}
