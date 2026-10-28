import type { AudioClip, Project } from "./types";
export {
  parseProjectSettings,
  mergeProjectSettings,
} from "./project-settings-schema";

/** Entity policy shared by preview, offline mix, and CLI exports. */
export function mutedAudioTrackIds(project: Project): string[] {
  return (project.audioTracks ?? [])
    .filter(
      (track) => project.settings?.audioTracks?.[track.id]?.muted === true,
    )
    .map((track) => track.id);
}

/** Saved clip settings override authored mute defaults by stable global clip ID. */
export function isAudioClipMuted(project: Project, clip: AudioClip): boolean {
  return project.settings?.audioClips?.[clip.id]?.muted ?? clip.muted ?? false;
}

export function mutedAudioClipIds(project: Project): string[] {
  return (project.audioTracks ?? [])
    .flatMap((track) => track.clips)
    .filter((clip) => isAudioClipMuted(project, clip))
    .map((clip) => clip.id);
}

/** Temporary caller exclusions may add to persisted mute, never undo it. */
export function audibleAudioTracks(
  project: Project,
  excluded: readonly string[] = [],
) {
  const muted = new Set([...mutedAudioTrackIds(project), ...excluded]);
  return (project.audioTracks ?? []).filter(
    (track) => !muted.has(track.id) && track.clips.length > 0,
  );
}
