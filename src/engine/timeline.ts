import { parseProjectSettings } from "./project-settings-schema";
import type { Project } from "./types";
import { resolveMediaProject } from "./media/project";
export function validateProject(p: Project) {
  p = resolveMediaProject(p);
  if (p.settings !== undefined) parseProjectSettings(p.settings);
  if (p.overlay !== undefined && typeof p.overlay !== "function")
    throw Error("Project overlay must be a scene factory.");
  if (!p.name || !Number.isFinite(p.duration) || p.duration <= 0)
    throw Error("Project needs a name and positive duration.");
  if (
    p.resolution.some((n) => !Number.isInteger(n) || n <= 0) ||
    p.aspectRatio.some((n) => !Number.isFinite(n) || n <= 0) ||
    Math.abs(
      p.resolution[0] / p.resolution[1] - p.aspectRatio[0] / p.aspectRatio[1],
    ) > 0.001
  )
    throw Error("Invalid project resolution or aspect ratio.");
  let end = 0;
  const ids = new Set<string>();
  let previousStart = 0;
  for (const [index, s] of p.scenes.entries()) {
    const transition = s.transition;
    const overlap = transition.type === "cut" ? 0 : transition.duration;
    if (
      ![
        "cut",
        "crossfade",
        "wipe",
        "slide",
        "zoom",
        "shared",
        "custom",
      ].includes(transition.type) ||
      (transition.type !== "cut" &&
        (!Number.isFinite(overlap) ||
          overlap <= 0 ||
          overlap >= s.duration ||
          index === 0 ||
          s.start <= previousStart + 1e-8)) ||
      (transition.type === "custom" &&
        (typeof transition.shader !== "string" ||
          !transition.shader.trim() ||
          transition.shader.length > 65536)) ||
      (transition.type !== "cut" &&
        transition.audioCrossfade !== undefined &&
        typeof transition.audioCrossfade !== "boolean") ||
      (transition.type !== "cut" &&
        transition.direction !== undefined &&
        !["left", "right", "up", "down"].includes(transition.direction))
    )
      throw Error(`Invalid scene transition: ${s.id}`);
    if (
      ids.has(s.id) ||
      !s.id ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.duration) ||
      s.duration <= 0 ||
      s.start < 0 ||
      Math.abs(s.start - (end - overlap)) > 1e-8 ||
      (index > 1 &&
        s.start <
          p.scenes[index - 2].start + p.scenes[index - 2].duration - 1e-8)
    )
      throw Error(`Invalid sequential scene: ${s.id}`);
    ids.add(s.id);
    previousStart = s.start;
    end = s.start + s.duration;
  }
  if (Math.abs(end - p.duration) > 1e-8)
    throw Error("Scene durations must fill the composition.");
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of p.audioTracks ?? []) {
    if (!track.id || trackIds.has(track.id))
      throw Error(`Invalid audio track: ${track.id}`);
    trackIds.add(track.id);
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const clip of clips) {
      if (
        !clip.id ||
        (clip.sceneId !== undefined && !ids.has(clip.sceneId)) ||
        clipIds.has(clip.id) ||
        !Number.isFinite(clip.start) ||
        !Number.isFinite(clip.duration) ||
        clip.duration <= 0 ||
        clip.start < -1e-8 ||
        clip.start + clip.duration > p.duration + 1e-8 ||
        clip.start < cursor - 1e-8
      )
        throw Error(`Invalid audio clip: ${clip.id || track.id}`);
      clipIds.add(clip.id);
      cursor = clip.start + clip.duration;
    }
  }
}
export function evaluate(p: Project, time: number) {
  if (!Number.isFinite(time)) throw Error("Timeline time must be finite.");
  const t = Math.max(0, Math.min(time, p.duration));
  const active = p.scenes.filter(
    (s) => t >= s.start && t < s.start + s.duration,
  );
  const entry = active[active.length - 1] ?? p.scenes[p.scenes.length - 1];
  if (!entry) throw Error("Timeline needs at least one scene.");
  return {
    entry,
    time: t,
    localTime: t - entry.start,
    progress: (t - entry.start) / entry.duration,
  };
}
/** At most two active scenes; the incoming entry owns overlap timing. */
export function evaluateActive(p: Project, time: number) {
  const primary = evaluate(p, time);
  const entries = p.scenes.filter(
    (s) => primary.time >= s.start && primary.time < s.start + s.duration,
  );
  if (!entries.length) entries.push(primary.entry);
  return {
    primary,
    active: entries.map((entry) => ({
      entry,
      time: primary.time,
      localTime: primary.time - entry.start,
      progress: (primary.time - entry.start) / entry.duration,
    })),
    transition:
      entries.length === 2 && primary.entry.transition.type !== "cut"
        ? {
            ...primary.entry.transition,
            progress: Math.max(
              0,
              Math.min(
                1,
                primary.localTime / primary.entry.transition.duration,
              ),
            ),
          }
        : undefined,
  };
}
export function frameCount(duration: number, fps: number) {
  return Math.ceil(duration * fps);
}
export function frameTiming(index: number, fps: number) {
  const timestamp = Math.round((index * 1e6) / fps);
  return {
    timestamp,
    duration: Math.round(((index + 1) * 1e6) / fps) - timestamp,
  };
}
