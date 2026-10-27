import type { Project } from "./types";
export {
  parseProjectSettings,
  mergeProjectSettings,
} from "./project-settings-schema.js";

/** Entity policy shared by preview, offline mix, and CLI exports. */
export function mutedAudioTrackIds(project: Project): string[] {
  return (project.audioTracks ?? [])
    .filter(
      (track) => project.settings?.audioTracks?.[track.id]?.muted === true,
    )
    .map((track) => track.id);
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
