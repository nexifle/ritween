export const COMP_ZOOM_MIN = 0.25;
export const COMP_ZOOM_MAX = 32;
export const TL_ZOOM_MIN = 0.1;
export const TL_ZOOM_MAX = 80;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const clock = (time: number) =>
  `${Math.floor(time / 60)
    .toString()
    .padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;

export function rulerStep(pxPerSec: number, fps: number) {
  const frame = 1 / fps;
  const raw = 78 / Math.max(pxPerSec, 0.0001);
  if (raw < 1) {
    const frames = [1, 2, 3, 5, 6, 10, 12, 15, 24, 30, 48, 60];
    return (
      (frames.find((count) => count <= fps && count * frame >= raw - 1e-9) ??
        fps) * frame
    );
  }
  const seconds = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return (
    seconds.find((step) => step >= raw - 1e-9) ?? Math.ceil(raw / 3600) * 3600
  );
}

export function formatRulerTime(time: number, step: number, fps: number) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const safe = Math.max(0, time);
  if (step < 1 - 1e-6) {
    const frames = Math.round(safe * fps);
    const ff = ((frames % fps) + fps) % fps;
    const total = Math.floor(frames / fps);
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}:${pad(ff)}`;
  }
  const whole = Math.floor(safe);
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  return `${pad(mm)}:${pad(ss)}`;
}

export function rulerMarks(
  duration: number,
  pxPerSec: number,
  fps: number,
  viewStart: number,
  viewEnd: number,
) {
  const major = rulerStep(pxPerSec, fps);
  // Subdivide in whole frames: dense ticks without implying sub-frame precision.
  const majorFrames = Math.max(1, Math.round(major * fps));
  const subdivisions = [10, 5, 4, 3, 2, 1];
  const minorDiv =
    subdivisions.find(
      (count) => majorFrames % count === 0 && (major * pxPerSec) / count >= 7,
    ) ?? 1;
  const minor = major / minorDiv;
  const first = Math.max(0, Math.floor((viewStart - major) / minor));
  const last = Math.ceil((viewEnd + major) / minor);
  const marks: { time: number; major: boolean }[] = [];
  for (let index = first; index <= last; index++) {
    const time = index * minor;
    if (time < -1e-6 || time > duration + 1e-4) continue;
    const snapped = Math.min(duration, Math.max(0, time));
    marks.push({
      time: snapped,
      major: Math.abs(snapped / major - Math.round(snapped / major)) < 1e-3,
    });
  }
  return { marks, major };
}

export function clampCompPan(
  zoom: number,
  panX: number,
  panY: number,
  width: number,
  height: number,
) {
  const maxX = Math.max(0, (width * zoom - width) / 2);
  const maxY = Math.max(0, (height * zoom - height) / 2);
  return { panX: clamp(panX, -maxX, maxX), panY: clamp(panY, -maxY, maxY) };
}
