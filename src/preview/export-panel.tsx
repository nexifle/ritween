import type { ExportSize } from "../engine/export-size";
import { frameCount } from "../engine/timeline";
import { Icon } from "./icon";

export function ExportPanel({
  ready,
  exporting,
  stage,
  resolution,
  sizes,
  aspectRatio,
  fps,
  duration,
  hasAudio,
  done,
  total,
  result,
  download,
  onResolution,
  onFps,
  onExport,
  onCancel,
}: {
  ready: boolean;
  exporting: boolean;
  stage: string;
  resolution: string;
  sizes: readonly ExportSize[];
  aspectRatio: readonly [number, number];
  fps: number;
  duration: number;
  hasAudio: boolean;
  done: number;
  total: number;
  result: string;
  download: string;
  onResolution: (resolution: string) => void;
  onFps: (fps: number) => void;
  onExport: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="p-3">
      <h2 className="mb-0.5 text-[13px] font-medium">Export video</h2>
      <p className="mb-2.5 text-[11px] leading-[1.4] text-muted-foreground">
        From source to a shareable MP4.
        <br />
        Rendered locally in your browser.
      </p>
      <label className="mb-1 block text-[11px] text-label" htmlFor="resolution">
        Resolution
      </label>
      {sizes.length ? (
        <select
          id="resolution"
          disabled={exporting}
          value={resolution}
          onChange={(e) => onResolution(e.target.value)}
          className="mb-2 h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-xs/normal"
        >
          {sizes.map((size) => (
            <option
              key={`${size.width}x${size.height}`}
              value={`${size.width}x${size.height}`}
            >
              {size.width} × {size.height}
              {size.name ? ` · ${size.name}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <p
          id="resolution"
          className="mb-2 text-[11px] text-destructive-foreground"
        >
          No export size keeps this aspect within H.264 Level 4.2.
        </p>
      )}
      <label className="mb-1 block text-[11px] text-label" htmlFor="fps">
        Frame rate
      </label>
      <select
        id="fps"
        disabled={exporting}
        value={fps}
        onChange={(e) => onFps(Number(e.target.value))}
        className="h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-xs/normal"
      >
        {[24, 30, 60].map((f) => (
          <option key={f} value={f}>
            {f} FPS
          </option>
        ))}
      </select>
      <div className="my-2.5 space-y-1 border-y border-border py-2 text-[11px]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Aspect</span>
          <span>{aspectRatio.join(":")}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Format</span>
          <span>{hasAudio ? "MP4 / H.264 / AAC" : "MP4 / H.264"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Duration</span>
          <span>{duration} seconds</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total frames</span>
          <span>{frameCount(duration, fps)}</span>
        </div>
      </div>
      <button
        onClick={onExport}
        disabled={!ready || exporting || !resolution}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm bg-primary text-xs/normal font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Icon name="export" size={16} />
        {exporting ? "Exporting…" : "Export Video"}
      </button>
      {exporting ? (
        <div className="mt-3.5 text-xs/normal">
          <p role="status" className="mb-2 text-muted-foreground">
            {stage}
          </p>
          <progress
            aria-label="Export progress"
            value={done}
            max={total}
            className="h-[5px] w-full accent-primary"
          />
          <div className="mt-2 flex justify-between text-progress">
            <span>
              {done} / {total} frames
            </span>
            <button onClick={onCancel} className="text-link hover:underline">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          Local mix · No upload required
        </p>
      )}
      {result && (
        <div
          role="status"
          className="mt-4 text-xs leading-[1.7] text-success-foreground"
        >
          {result}
          {download && (
            <a
              href={download}
              download="source-to-motion.mp4"
              className="block text-download underline underline-offset-4"
            >
              Download MP4 again
            </a>
          )}
        </div>
      )}
    </section>
  );
}
