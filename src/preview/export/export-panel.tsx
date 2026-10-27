import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveEncodingOptions } from "../../engine/export-settings";
import type { ExportSize } from "../../engine/export-size";
import { frameCount } from "../../engine/timeline";
import { Icon } from "../components/icon";
import { SidebarPanel } from "../components/sidebar-panel";

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
  borderTop,
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
  const started = useRef(0);
  const firstFrame = useRef<{ time: number; frames: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!exporting) return;
    started.current = performance.now();
    firstFrame.current = null;
    setElapsed(0);
    setRemaining(null);
    const timer = window.setInterval(() => {
      setElapsed((performance.now() - started.current) / 1000);
    }, 1000);
    return () => {
      window.clearInterval(timer);
      setElapsed((performance.now() - started.current) / 1000);
    };
  }, [exporting]);
  useEffect(() => {
    if (!exporting || done <= 0) return;
    const now = performance.now();
    if (!firstFrame.current) firstFrame.current = { time: now, frames: done };
    const sample = firstFrame.current;
    const seconds = (now - sample.time) / 1000;
    if (seconds >= 2 && done > sample.frames) {
      setRemaining(((total - done) * seconds) / (done - sample.frames));
    }
  }, [done, total, exporting]);
  const complete = Boolean(result && download && !exporting);
  const finalizing = done >= total && total > 0;
  const percent =
    total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0;
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
      <div ref={statusRef}>
        {!exporting && result && !download && (
          <div
            role="status"
            className="mb-3 flex items-start gap-2.5 border-l-2 border-border py-1 pl-3"
          >
            <Icon
              name="pause"
              size={16}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
            <div>
              <p className="text-[12px] font-medium">Export stopped</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                No file created. Your settings are saved.
              </p>
            </div>
          </div>
        )}
        {!exporting && !complete && (
          <button
            onClick={onExport}
            disabled={!ready || !resolution}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-sm bg-primary text-[12px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Icon name={result ? "restart" : "export"} size={16} />
            {result ? "Retry export" : "Export video"}
          </button>
        )}
        {exporting && (
          <section
            className="export-monitor"
            aria-label="Export activity"
            aria-busy="true"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="export-beacon" aria-hidden="true" />
                {finalizing ? "Finishing your video" : "Rendering your video"}
              </div>
              <span className="text-[20px] font-semibold tabular-nums tracking-tight">
                {percent}
                <span className="text-[11px] text-muted-foreground">%</span>
              </span>
            </div>
            <p
              role="status"
              className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground"
            >
              {stage}
            </p>
            <div className="export-filmstrip" aria-hidden="true">
              {Array.from({ length: 24 }, (_, i) => (
                <span
                  key={i}
                  className={
                    i / 24 < done / Math.max(total, 1) ? "is-rendered" : ""
                  }
                />
              ))}
            </div>
            <div
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${percent} percent, ${done} of ${total} frames`}
              className="export-meter"
            >
              <div style={{ width: `${percent}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
              <div>
                <div className="text-muted-foreground">Time elapsed</div>
                <div className="mt-1 text-[14px] font-medium tabular-nums">
                  {formatExportTime(elapsed)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Estimated remaining</div>
                <div className="mt-1 text-[14px] font-medium tabular-nums">
                  {finalizing
                    ? "Finishing…"
                    : remaining === null
                      ? "Calculating…"
                      : `~ ${formatExportTime(Math.max(1, remaining))}`}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {finalizing
                ? "Frames encoded. Completing audio and packaging MP4."
                : remaining === null
                  ? "Estimating from the first rendered frames."
                  : "Estimate updates as frames are rendered."}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5 text-[11px]">
              <span className="tabular-nums text-muted-foreground">
                {done.toLocaleString()} / {total.toLocaleString()} frames
              </span>
              <button
                onClick={onCancel}
                className="rounded-sm px-2 py-1 text-link hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
              >
                Cancel export
              </button>
            </div>
          </section>
        )}
        {complete && (
          <section role="status" className="export-monitor export-complete">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <Icon name="check" size={20} />
              <span>Your video is ready</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {result}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Exported in {formatExportTime(elapsed)}. Download started
              automatically.
            </p>
            <a
              href={download}
              download="source-to-motion.mp4"
              className="mt-3 flex h-9 items-center justify-center gap-2 rounded-sm bg-primary text-[12px] font-semibold text-primary-foreground hover:bg-primary-hover"
            >
              <Icon name="export" size={16} />
              Download MP4
            </a>
            <button
              onClick={onExport}
              disabled={!ready || !resolution}
              className="mt-2 w-full rounded-sm py-2 text-[11px] text-link hover:bg-secondary disabled:opacity-45"
            >
              Export again
            </button>
          </section>
        )}
      </div>
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
