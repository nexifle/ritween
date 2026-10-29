import { resolveEncodingOptions } from "../../engine/export/settings";
import type { ExportSize } from "../../engine/export/formats/mp4/sizes";
import { frameCount } from "../../engine/timeline";
import { Icon } from "../components/icon";
import { formatExportBytes, formatExportTime } from "./export-format";

export interface ExportSettingsProps {
  resolution: string;
  sizes: readonly ExportSize[];
  aspectRatio: readonly [number, number];
  fps: number;
  bitrate: number;
  latencyMode: "quality" | "realtime";
  keyFrameInterval: number;
  duration: number;
  hasAudio: boolean;
  disabled: boolean;
  onResolution: (resolution: string) => void;
  onFps: (fps: number) => void;
  onBitrate: (bitrate: number) => void;
  onLatencyMode: (mode: "quality" | "realtime") => void;
  onKeyFrameInterval: (seconds: number) => void;
}

const select =
  "h-7 w-full min-w-0 rounded-[3px] border border-input bg-popover px-2 text-[11px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const label = "mb-1 block text-[11px] text-label";

export function ExportSettings({
  resolution,
  sizes,
  aspectRatio,
  fps,
  bitrate,
  latencyMode,
  keyFrameInterval,
  duration,
  hasAudio,
  disabled,
  onResolution,
  onFps,
  onBitrate,
  onLatencyMode,
  onKeyFrameInterval,
}: ExportSettingsProps) {
  const [width, height] = resolution.split("x").map(Number);
  const autoBitrate =
    width && height ? resolveEncodingOptions(width, height, fps).bitrate : 0;
  const effectiveBitrate = bitrate || autoBitrate;
  const bitrateLabel = bitrate ? `${bitrate / 1e6} Mbps` : "Auto";
  const estimatedBytes =
    ((effectiveBitrate + (hasAudio ? 128000 : 0)) * duration) / 8;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-2">
        <div>
          <label className={label} htmlFor="resolution">
            Resolution
          </label>
          <select
            id="resolution"
            className={select}
            disabled={disabled || !sizes.length}
            value={resolution}
            onChange={(event) => onResolution(event.target.value)}
          >
            {!sizes.length && <option value="">Unavailable</option>}
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
        </div>
        <div>
          <label className={label} htmlFor="fps">
            Frame rate
          </label>
          <select
            id="fps"
            className={select}
            disabled={disabled}
            value={fps}
            onChange={(event) => onFps(Number(event.target.value))}
          >
            {[24, 30, 60].map((value) => (
              <option key={value} value={value}>
                {value} FPS
              </option>
            ))}
          </select>
        </div>
      </div>
      {!sizes.length && (
        <p className="text-[11px] text-destructive-foreground">
          No resolution fits this aspect ratio within H.264 limits.
        </p>
      )}
      <details className="group border-y border-separator/70">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <Icon
            name="chevron-right"
            size={12}
            className="text-control transition-transform group-open:rotate-90 motion-reduce:transition-none"
          />
          <span className="text-label">Encoding</span>
          <span className="ml-auto truncate pl-2 text-meta">
            {bitrateLabel} ·{" "}
            {latencyMode === "quality" ? "Quality" : "Low latency"}
          </span>
        </summary>
        <div className="space-y-2 pb-3 pt-1">
          <div>
            <label className={label} htmlFor="video-bitrate">
              Video bitrate
            </label>
            <select
              id="video-bitrate"
              className={select}
              disabled={disabled}
              value={bitrate}
              title="Higher bitrate preserves more detail and makes larger files. Auto follows resolution and frame rate."
              onChange={(event) => onBitrate(Number(event.target.value))}
            >
              <option value={0}>
                Auto · {(autoBitrate / 1e6).toFixed(1)} Mbps · recommended
              </option>
              {[
                ...new Set([
                  2,
                  4,
                  6,
                  8,
                  12,
                  20,
                  ...(bitrate ? [bitrate / 1e6] : []),
                ]),
              ]
                .sort((a, b) => a - b)
                .map((mbps) => (
                  <option key={mbps} value={mbps * 1e6}>
                    {mbps} Mbps
                  </option>
                ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={label} htmlFor="encoding-mode">
                Mode
              </label>
              <select
                id="encoding-mode"
                className={select}
                disabled={disabled}
                value={latencyMode}
                onChange={(event) =>
                  onLatencyMode(event.target.value as "quality" | "realtime")
                }
              >
                <option value="quality">Quality · recommended</option>
                <option value="realtime">Low latency</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="keyframe-interval">
                Keyframes
              </label>
              <select
                id="keyframe-interval"
                className={select}
                disabled={disabled}
                value={keyFrameInterval}
                title="Maximum spacing between requested keyframes. Two seconds is recommended."
                onChange={(event) =>
                  onKeyFrameInterval(Number(event.target.value))
                }
              >
                {[...new Set([1, 2, 4, keyFrameInterval])]
                  .sort((a, b) => a - b)
                  .map((seconds) => (
                    <option key={seconds} value={seconds}>
                      Every {seconds}s{seconds === 2 ? " · recommended" : ""}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </div>
      </details>
      <div
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-meta"
        title={`${aspectRatio.join(":")} · ${frameCount(duration, fps)} frames. File size is estimated from bitrate and duration.`}
      >
        <span>MP4 · H.264{hasAudio ? " + AAC" : ""}</span>
        <span className="tabular-nums">
          {formatExportTime(duration)} · ~{formatExportBytes(estimatedBytes)}
        </span>
      </div>
    </div>
  );
}
