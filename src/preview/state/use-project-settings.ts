import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Project,
  ProjectSettings,
  ProjectExportSettings,
} from "../../engine/types";
import {
  mergeProjectSettings,
  mutedAudioClipIds,
  mutedAudioTrackIds,
  parseProjectSettings,
} from "../../engine/project-settings";

/** Persist entity commands, keeping studio-only state out of the project. */
export function useProjectSettings(
  source: Project,
  authored: ProjectSettings | undefined,
  initialSaved: ProjectSettings,
) {
  const [saved, setSaved] = useState(initialSaved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const project = useMemo(
    () => ({ ...source, settings: mergeProjectSettings(authored, saved) }),
    [source, authored, saved],
  );
  const mutedTrackIds = useMemo(() => mutedAudioTrackIds(project), [project]);
  const mutedClipIds = useMemo(() => mutedAudioClipIds(project), [project]);

  useEffect(() => {
    const receive = (value: unknown) => {
      try {
        setSaved(parseProjectSettings(value));
        setError("");
      } catch (error) {
        setError(String(error));
      }
    };
    const failed = (message: string) => setError(message);
    import.meta.hot?.on("ritween:settings", receive);
    import.meta.hot?.on("ritween:settings-error", failed);
    return () => {
      import.meta.hot?.off("ritween:settings", receive);
      import.meta.hot?.off("ritween:settings-error", failed);
    };
  }, []);

  const saveCommand = useCallback(async (command: object, label: string) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/__ritween/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Error(
          body.error ??
            "Project settings could not be saved. Start the project with the Ritween development server.",
        );
      }
      setSaved(parseProjectSettings(await response.json()));
    } catch (error) {
      setError(
        `${label} was not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, []);
  const toggleTrackMute = useCallback(
    (id: string) => {
      if (!(source.audioTracks ?? []).some((track) => track.id === id)) return;
      return saveCommand(
        {
          type: "set-audio-track-muted",
          id,
          muted: !mutedTrackIds.includes(id),
        },
        "Mute",
      );
    },
    [source, mutedTrackIds, saveCommand],
  );
  const toggleClipMute = useCallback(
    (id: string) => {
      if (
        !(source.audioTracks ?? []).some((track) =>
          track.clips.some((clip) => clip.id === id),
        )
      )
        return;
      return saveCommand(
        {
          type: "set-audio-clip-muted",
          id,
          muted: !mutedClipIds.includes(id),
        },
        "Mute clip",
      );
    },
    [source, mutedClipIds, saveCommand],
  );
  const updateExportSettings = useCallback(
    (patch: ProjectExportSettings) =>
      saveCommand({ type: "update-export-settings", patch }, "Export settings"),
    [saveCommand],
  );
  return {
    project,
    mutedTrackIds,
    mutedClipIds,
    toggleTrackMute,
    toggleClipMute,
    updateExportSettings,
    saving,
    error,
  };
}
