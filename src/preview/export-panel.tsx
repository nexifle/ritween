import { resolveEncodingOptions } from "../engine/export-settings";
import type { ExportSize } from "../engine/export-size";
import { frameCount } from "../engine/timeline";
import { Icon } from "./icon";
import { SidebarPanel } from "./sidebar-panel";

export function ExportPanel({
  ready,
  exporting,
  stage,
  resolution,
  sizes,
  aspectRatio,
  fps,
  bitrate,
  latencyMode,
  keyFrameInterval,
  onBitrate,
  onLatencyMode,
  onKeyFrameInterval,
  duration,
  hasAudio,
  done,
  total,
  result,
  download,
  collapsed,
  onToggleCollapse,
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
  bitrate: number;
  latencyMode: "quality" | "realtime";
  keyFrameInterval: number;
  onBitrate: (bitrate: number) => void;
  onLatencyMode: (mode: "quality" | "realtime") => void;
  onKeyFrameInterval: (seconds: number) => void;
  duration: number;
  hasAudio: boolean;
  done: number;
  total: number;
  result: string;
  download: string;
  collapsed?: boolean;
  onToggleCollapse?: (collapsed: boolean) => void;
  onResolution: (resolution: string) => void;
  onFps: (fps: number) => void;
  onExport: () => void;
  onCancel: () => void;
}) {
  return (
    <SidebarPanel
      icon="export"
      title="Export video"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      contentClassName="p-3"
    >
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
          className="mb-2 h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-[11px]"
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
        className="h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-[11px]"
      >
        {[24, 30, 60].map((f) => (
          <option key={f} value={f}>
            {f} FPS
          </option>
        ))}
      </select>
      <label
        className="mb-1 mt-2 block text-[11px] text-label"
        htmlFor="video-bitrate"
      >
        Video bitrate
      </label>
      <select
        id="video-bitrate"
        disabled={exporting}
        value={bitrate}
        onChange={(e) => onBitrate(Number(e.target.value))}
        className="h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-[11px]"
      >
        <option value={0}>
          Auto
          {resolution
            ? ` · ${(resolveEncodingOptions(Number(resolution.split("x")[0]), Number(resolution.split("x")[1]), fps).bitrate / 1e6).toFixed(1)} Mbps`
            : ""}
        </option>
        {[2, 4, 6, 8, 12, 20].map((mbps) => (
          <option key={mbps} value={mbps * 1e6}>
            {mbps} Mbps
          </option>
        ))}
      </select>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Higher bitrate keeps more detail and increases file size.
      </p>
      <label
        className="mb-1 mt-2 block text-[11px] text-label"
        htmlFor="encoding-mode"
      >
        Encoding mode
      </label>
      <select
        id="encoding-mode"
        disabled={exporting}
        value={latencyMode}
        onChange={(e) =>
          onLatencyMode(e.target.value as "quality" | "realtime")
        }
        className="h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-[11px]"
      >
        <option value="quality">Quality · recommended</option>
        <option value="realtime">Low latency</option>
      </select>
      <label
        className="mb-1 mt-2 block text-[11px] text-label"
        htmlFor="keyframe-interval"
      >
        Keyframe interval
      </label>
      <select
        id="keyframe-interval"
        disabled={exporting}
        value={keyFrameInterval}
        onChange={(e) => onKeyFrameInterval(Number(e.target.value))}
        className="h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-[11px]"
      >
        {[1, 2, 4].map((seconds) => (
          <option key={seconds} value={seconds}>
            {seconds} seconds{seconds === 2 ? " · recommended" : ""}
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
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm bg-primary text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Icon name="export" size={16} />
        {exporting ? "Exporting…" : "Export Video"}
      </button>
      {exporting ? (
        <div className="mt-3.5 text-[11px]">
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
          className="mt-4 text-[11px] leading-[1.7] text-success-foreground"
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
    </SidebarPanel>
  );
}
