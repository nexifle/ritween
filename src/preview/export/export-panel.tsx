import { useLayoutEffect, useMemo, useRef } from "react";
import type { ExportJob } from "../../engine/export/job";
import { ExportFiles } from "./export-files";
import { resolveEncodingOptions } from "../../engine/export/settings";
import type { ExportSize } from "../../engine/export/formats/mp4/sizes";
import { frameCount } from "../../engine/timeline";
import { Icon } from "../components/icon";
import { SidebarPanel } from "../components/sidebar-panel";

export function ExportPanel({
  ready,
  exporting,
  savingSettings,
  job,
  jobs,
  connected,
  onDelete,
  onCancelJob,
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
  filename,
  collapsed,
  onToggleCollapse,
  onResolution,
  onFps,
  onExport,
  onCancel,
  borderTop,
}: {
  ready: boolean;
  exporting: boolean;
  savingSettings?: boolean;
  job?: ExportJob;
  jobs: readonly ExportJob[];
  connected: boolean;
  onDelete: (id: string) => void;
  onCancelJob: (id: string) => void;
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
  filename: string;
  collapsed?: boolean;
  onToggleCollapse?: (collapsed: boolean) => void;
  onResolution: (resolution: string) => void;
  onFps: (fps: number) => void;
  onExport: () => void;
  onCancel: () => void;
  borderTop?: boolean;
}) {
  const statusRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (collapsed || (!exporting && !result)) return;
    const status = statusRef.current;
    const scroller = status?.parentElement;
    if (!status || !scroller) return;
    // Scroll only this panel, once per state transition. Frame updates must
    // never pull the user away from settings they are inspecting.
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        status.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        12,
      behavior: "instant",
    });
  }, [exporting, result, collapsed]);
  const elapsed = job?.elapsedSeconds ?? 0;
  const remaining = job?.etaSeconds ?? null;
  const stageLabels: Record<string, string> = {
    "audio-mix": "Mixing audio",
    "audio-encode": "Encoding audio",
    "scene-setup": "Preparing scenes",
    "video-encode": "Encoding video",
    mux: "Finalizing MP4",
  };
  const stage =
    job?.status === "preparing"
      ? "Preparing source snapshot…"
      : job?.status === "queued"
        ? "Waiting for the previous export…"
        : job?.status === "saving"
          ? "Saving MP4 on the server…"
          : job?.stages
              .map((value) => stageLabels[value] ?? value)
              .join(" + ") || "Starting headless renderer…";
  const complete = Boolean(result && download && !exporting);
  const finalizing = job?.status === "saving" || (done >= total && total > 0);
  const percent = job?.percent ?? 0;
  const resultParts = useMemo(() => {
    if (!result || !result.includes("·")) return { summary: result, size: "" };
    const segments = result.split("·").map((s) => s.trim());
    if (segments.length >= 3) {
      return {
        summary: `${segments[0]} · ${segments[1]}`,
        size: segments[2],
      };
    }
    return { summary: result, size: "" };
  }, [result]);
  const [width, height] = resolution.split("x").map(Number);
  const effectiveBitrate =
    width && height
      ? resolveEncodingOptions(width, height, fps, {
          bitrate: bitrate || undefined,
        }).bitrate
      : 0;
  return (
    <SidebarPanel
      borderTop={borderTop}
      icon="export"
      title="Export video"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      contentClassName="p-3"
    >
      {!connected && (
        <p role="status" className="mb-2 text-[11px] text-meta">
          Connecting to export server… Running exports continue on the server.
        </p>
      )}
      {savingSettings && (
        <p role="status" className="mb-2 text-[11px] text-meta">
          Saving settings…
        </p>
      )}
      <label className="mb-1 block text-[11px] text-label" htmlFor="resolution">
        Resolution
      </label>
      {sizes.length ? (
        <select
          id="resolution"
          disabled={exporting || savingSettings}
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
        disabled={exporting || savingSettings}
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
        disabled={exporting || savingSettings}
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
        {[...new Set([2, 4, 6, 8, 12, 20, ...(bitrate ? [bitrate / 1e6] : [])])]
          .sort((a, b) => a - b)
          .map((mbps) => (
            <option key={mbps} value={mbps * 1e6}>
              {mbps} Mbps
            </option>
          ))}
      </select>
      <p className="mt-1 text-[11px] text-muted-foreground">
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
        disabled={exporting || savingSettings}
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
        disabled={exporting || savingSettings}
        value={keyFrameInterval}
        onChange={(e) => onKeyFrameInterval(Number(e.target.value))}
        className="h-[30px] w-full rounded-sm border border-input bg-popover px-2 text-[11px]"
      >
        {[...new Set([1, 2, 4, keyFrameInterval])]
          .sort((a, b) => a - b)
          .map((seconds) => (
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
          <span>{formatExportTime(duration)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total frames</span>
          <span>{frameCount(duration, fps)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span
            className="text-muted-foreground"
            title="Estimated from bitrate and duration. Actual file size varies with content."
          >
            Estimated size
          </span>
          <span className="tabular-nums">
            ~{" "}
            {(
              ((effectiveBitrate + (hasAudio ? 128000 : 0)) * duration) /
              8 /
              1048576
            ).toFixed(1)}{" "}
            MB
          </span>
        </div>
      </div>
      <div ref={statusRef} className="pt-1">
        {!exporting && result && !download && (
          <section
            role="status"
            className="rounded-md border border-separator bg-secondary/50 p-2.5 space-y-2 transition-all"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
                <Icon
                  name="stop"
                  size={13}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate text-[12px] font-semibold text-foreground">
                  Export stopped
                </span>
              </div>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-meta">
                Settings saved
              </span>
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {result} No file created. Your settings are preserved.
            </p>

            <button
              type="button"
              onClick={onExport}
              disabled={!ready || !resolution}
              aria-label="Export Video"
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm bg-primary text-[11px] font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
            >
              <Icon name="restart" size={13} />
              <span>Retry export</span>
            </button>
          </section>
        )}

        {!exporting && !complete && !result && (
          <button
            type="button"
            onClick={onExport}
            disabled={!ready || !resolution}
            aria-label="Export Video"
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm bg-primary text-[11px] font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            <Icon name="export" size={14} />
            <span>Export video</span>
          </button>
        )}

        {exporting && (
          <section
            aria-label="Export activity"
            aria-busy="true"
            className="rounded-md border border-separator bg-secondary/50 p-2.5 space-y-2 transition-all"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                <span className="truncate text-[12px] font-semibold text-foreground">
                  {finalizing ? "Finishing MP4…" : "Rendering video…"}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-foreground">
                {percent}
                <span className="text-[11px] font-normal text-muted-foreground">
                  %
                </span>
              </span>
            </div>

            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="truncate pr-2 font-medium text-foreground/80">
                {stage}
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {done.toLocaleString()} / {total.toLocaleString()} f
              </span>
            </div>

            <div
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${percent} percent, ${done} of ${total} frames`}
              className="relative h-1.5 w-full overflow-hidden rounded-full bg-popover border border-border/40"
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px]">
              <div className="flex items-center gap-1.5 font-mono text-muted-foreground tabular-nums">
                <span title="Elapsed time">{formatExportTime(elapsed)}</span>
                <span className="text-muted-foreground/40">·</span>
                <span title="Estimated remaining time">
                  {finalizing
                    ? "Finishing…"
                    : remaining === null
                      ? "Calculating…"
                      : `~${formatExportTime(Math.max(1, remaining))} left`}
                </span>
              </div>
              <button
                type="button"
                onClick={onCancel}
                className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive-foreground cursor-pointer"
                title="Cancel export"
              >
                <Icon name="cancel" size={11} />
                <span>Cancel</span>
              </button>
            </div>
          </section>
        )}

        {complete && (
          <section
            role="status"
            className="rounded-md border border-separator bg-secondary/50 p-2.5 space-y-2 transition-all"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon
                  name="check"
                  size={15}
                  className="shrink-0 text-primary"
                />
                <span className="truncate text-[12px] font-semibold text-foreground">
                  Your video is ready
                </span>
              </div>
              {resultParts.size && (
                <span className="shrink-0 rounded border border-border/50 bg-popover px-1.5 py-0.5 font-mono text-[11px] font-medium text-emphasis tabular-nums">
                  {resultParts.size}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>{resultParts.summary || result}</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-foreground/80 font-medium font-mono tabular-nums">
                in {formatExportTime(elapsed)}
              </span>
            </div>

            <p className="text-[11px] leading-tight text-muted-foreground">
              Your video is stored temporarily on the server. Download it before
              stopping the server.
            </p>

            <div className="flex items-center gap-1.5 pt-0.5">
              <a
                href={download}
                download={filename}
                className="flex h-7.5 flex-1 items-center justify-center gap-1.5 rounded-sm bg-primary px-3 text-[11px] font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary-hover"
              >
                <Icon name="export" size={13} />
                <span>Download MP4</span>
              </a>
              <button
                type="button"
                onClick={onExport}
                disabled={!ready || !resolution}
                title="Export again with current settings"
                className="flex h-7.5 items-center justify-center gap-1 rounded-sm border border-border bg-secondary/80 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40 cursor-pointer"
              >
                <Icon name="restart" size={12} />
                <span>Export again</span>
              </button>
            </div>
          </section>
        )}
      </div>
      <ExportFiles jobs={jobs} onDelete={onDelete} onCancel={onCancelJob} />
    </SidebarPanel>
  );
}

export function formatExportTime(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours
    ? `${hours}h ${minutes}m ${rest}s`
    : minutes
      ? `${minutes}m ${rest}s`
      : `${rest}s`;
}
