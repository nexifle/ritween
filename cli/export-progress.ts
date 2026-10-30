import type { ExportStage } from "../src/engine/export/types";

const stageLabels: Record<ExportStage, string> = {
  "audio-mix": "Mixing audio",
  "audio-encode": "Encoding audio",
  "scene-setup": "Preparing scenes",
  "video-encode": "Encoding video",
  mux: "Finalizing MP4",
};
const count = new Intl.NumberFormat("en-US");
const clearProgress = "\r\u001b[0J";

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds * 100) / 100;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = Number((rounded % 60).toFixed(2));
  return [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    remainder || (!hours && !minutes) ? `${remainder}s` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatExportResult(result: {
  output: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  bytes: number;
  elapsedSeconds: number;
}) {
  return [
    `Export completed in ${result.elapsedSeconds.toFixed(2)}s`,
    `  Output  ${result.output}`,
    `  Video   ${result.width}×${result.height} · ${result.fps} FPS · ${formatDuration(result.duration)}`,
    `  Frames  ${count.format(result.frames)}`,
    `  Size    ${(result.bytes / 2 ** 20).toFixed(2)} MiB`,
  ].join("\n");
}

export function createExportProgress({
  json = false,
  stream = process.stderr,
  now = () => performance.now(),
}: {
  json?: boolean;
  stream?: {
    isTTY?: boolean;
    columns?: number;
    write: (text: string) => unknown;
  };
  now?: () => number;
} = {}) {
  const interactive = !json && stream.isTTY === true;
  const started = now();
  const active = new Set<string>();
  let phase = "Preparing renderer";
  let done = 0;
  let total = 0;
  let videoStarted: number | undefined;
  let lastPercent = -1;
  let lastDraw = -Infinity;
  let lastBlock = "";
  let stopped = false;

  function label(stage: string) {
    if (stage === "video-encode" && total > 0 && done === total)
      return "Finishing video";
    return stageLabels[stage as ExportStage] ?? stage;
  }

  function draw(force = false) {
    if (stopped || !interactive) return;
    const time = now();
    if (!force && time - lastDraw < 100) return;
    lastDraw = time;
    const stage = active.size ? [...active].map(label).join(" + ") : phase;
    const elapsed = `${formatDuration(Math.floor((time - started) / 1000))} elapsed`;
    const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
    const frames = `${count.format(done)}/${count.format(total)} frames`;
    const encodingSeconds =
      videoStarted === undefined ? 0 : (time - videoStarted) / 1000;
    const estimating =
      active.has("video-encode") &&
      done > 0 &&
      done < total &&
      encodingSeconds >= 1;
    const rate = estimating ? done / encodingSeconds : 0;
    const speed = estimating
      ? `${Math.round(rate)} fps · ETA ${formatDuration(Math.ceil((total - done) / rate))}`
      : "";
    // Leave the last terminal column unused to prevent automatic line wrapping.
    const width = Math.max(0, (stream.columns || 80) - 1);
    const prefix = width >= 24 ? "Export " : "";
    const suffix = `${width >= 12 ? " " : ""}${percent}%`;
    const barWidth = Math.min(32, width - prefix.length - suffix.length - 2);
    const filled = Math.floor((percent / 100) * Math.max(0, barWidth));
    const bar =
      barWidth > 0
        ? `${prefix}[${"=".repeat(filled)}${"-".repeat(barWidth - filled)}]${suffix}`
        : "[]".slice(0, width);
    const candidates = [
      [stage, total > 0 ? frames : "", speed, elapsed],
      [stage, total > 0 ? frames : "", speed],
      [stage, speed],
      [stage, total > 0 ? frames : ""],
      [stage, elapsed],
      [stage],
    ].map((parts) => parts.filter(Boolean).join(" · "));
    const details =
      candidates.find((text) => text.length <= width) ?? stage.slice(0, width);
    const block = `${bar}\n\r${details}`;
    if (block === lastBlock) return;
    const hideCursor = lastBlock ? "" : "\u001b[?25l";
    lastBlock = block;
    // Anchor at the first row so resizing cannot strand wrapped detail rows.
    stream.write(`${clearProgress}${hideCursor}${block}\r\u001b[1A`);
  }

  function message(text: string) {
    if (!json && !interactive) stream.write(`Export · ${text}\n`);
  }

  message(phase);
  draw(true);
  const timer = interactive ? setInterval(() => draw(), 100) : undefined;
  timer?.unref();

  return {
    stage(stage: string) {
      if (stopped) return;
      active.add(stage);
      if (stage === "video-encode") videoStarted ??= now();
      if (json) stream.write(`${JSON.stringify({ event: "stage", stage })}\n`);
      else message(label(stage));
      draw(true);
    },
    stageComplete(stage: string) {
      if (stopped) return;
      active.delete(stage);
      phase = "Finalizing export";
      draw(true);
    },
    update(completed: number, expected: number) {
      if (
        stopped ||
        !Number.isFinite(completed) ||
        !Number.isFinite(expected) ||
        expected <= 0
      )
        return;
      done = Math.min(expected, Math.max(0, completed));
      total = expected;
      if (done > 0) videoStarted ??= now();
      if (phase === "Preparing renderer") phase = "Preparing export";
      const percent = Math.floor((done / total) * 10) * 10;
      if (percent !== lastPercent) {
        lastPercent = percent;
        if (json)
          stream.write(
            `${JSON.stringify({ event: "progress", done, total, percent })}\n`,
          );
        else if (!interactive)
          stream.write(
            `Export ${percent}% · ${count.format(done)}/${count.format(total)} frames\n`,
          );
      }
      draw(done === total);
    },
    saving() {
      if (stopped) return;
      active.clear();
      phase = "Saving file";
      message(phase);
      draw(true);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (interactive) stream.write(`${clearProgress}\u001b[?25h`);
    },
  };
}
