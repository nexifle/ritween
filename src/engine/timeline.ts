import type { Project } from "./types";
export function validateProject(p: Project) {
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
  for (const s of p.scenes) {
    if (
      ids.has(s.id) ||
      !s.id ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.duration) ||
      s.duration <= 0 ||
      Math.abs(s.start - end) > 1e-8 ||
      s.transition.type !== "cut"
    )
      throw Error(`Invalid sequential scene: ${s.id}`);
    ids.add(s.id);
    end = s.start + s.duration;
  }
  if (Math.abs(end - p.duration) > 1e-8)
    throw Error("Scene durations must fill the composition.");
}
export function evaluate(p: Project, time: number) {
  if (!Number.isFinite(time)) throw Error("Timeline time must be finite.");
  const t = Math.max(0, Math.min(time, p.duration));
  const entry =
    p.scenes.find((s) => t >= s.start && t < s.start + s.duration) ??
    p.scenes[p.scenes.length - 1];
  return {
    entry,
    time: t,
    localTime: t - entry.start,
    progress: (t - entry.start) / entry.duration,
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
