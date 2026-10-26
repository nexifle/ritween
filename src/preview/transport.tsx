import { frameCount } from "../engine/timeline";
import { Icon } from "./icon";
import { clock } from "./view";

export function Transport({
  ready,
  playing,
  time,
  duration,
  fps,
  volumeDb,
  masterMuted,
  onSeek,
  onToggle,
  onMasterMute,
  onVolume,
}: {
  ready: boolean;
  playing: boolean;
  time: number;
  duration: number;
  fps: number;
  volumeDb: number;
  masterMuted: boolean;
  onSeek: (time: number) => void;
  onToggle: () => void;
  onMasterMute: () => void;
  onVolume: (volumeDb: number) => void;
}) {
  const total = frameCount(duration, fps);
  const currentFrame = Math.min(Math.floor(time * fps), Math.max(0, total - 1));
  const progressPercent =
    duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;
  const volumePercent = Math.min(
    100,
    Math.max(0, ((volumeDb + 60) / 60) * 100),
  );

  return (
    <div className="flex w-full select-none flex-col">
      {/* Scrubber slider: compact, full width, After Effects / Premiere Pro mini-timeline style */}
      <div className="relative flex w-full items-center pb-1 pt-0.5">
        <input
          aria-label="Playback scrubber"
          type="range"
          min={0}
          max={duration}
          step={1 / fps}
          value={time}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="transport-scrubber w-full accent-primary"
          style={{
            background: `linear-gradient(to right, var(--primary) ${progressPercent}%, var(--separator) ${progressPercent}%)`,
          }}
        />
      </div>

      {/* Controls row: Premiere Pro / After Effects layout with clear 3-zone hierarchy */}
      <div className="flex h-7 items-center justify-between gap-2 text-[11px]">
        {/* Zone 1 (Left): Timecode Display */}
        <div className="flex min-w-0 items-center gap-1 font-mono tabular-nums leading-none">
          <span className="font-semibold text-emphasis">{clock(time)}</span>
          <span className="text-time-slash">/</span>
          <span className="text-time">{clock(duration)}</span>
        </div>

        {/* Zone 2 (Center): Playback Transport Cluster */}
        <div className="flex items-center justify-center gap-0.5">
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded text-icon transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            disabled={!ready}
            onClick={() => onSeek(0)}
            aria-label="Restart"
            title="Restart"
          >
            <Icon name="restart" size={14} />
          </button>
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded text-icon transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            disabled={!ready}
            onClick={() => onSeek(time - 1 / fps)}
            aria-label="Previous frame"
            title="Previous frame"
          >
            <Icon name="back" size={14} />
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={onToggle}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            className="mx-0.5 flex h-6 w-8 items-center justify-center rounded-[3px] bg-play text-play-foreground transition-colors hover:bg-play-hover active:opacity-90 disabled:opacity-30"
          >
            <Icon name={playing ? "pause" : "play"} size={14} />
          </button>
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded text-icon transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
            disabled={!ready}
            onClick={() => onSeek(time + 1 / fps)}
            aria-label="Next frame"
            title="Next frame"
          >
            <Icon name="next" size={14} />
          </button>
        </div>

        {/* Zone 3 (Right): Audio Controls & Frame Counter */}
        <div className="flex min-w-0 items-center justify-end gap-2.5">
          <div className="flex items-center gap-1.5 text-time">
            <button
              type="button"
              aria-label={masterMuted ? "Unmute mix" : "Mute mix"}
              aria-pressed={masterMuted}
              onClick={onMasterMute}
              title={masterMuted ? "Unmute mix" : "Mute mix"}
              className={`flex size-6 items-center justify-center rounded transition-colors ${
                masterMuted
                  ? "border border-primary/50 bg-muted-track text-muted-track-foreground"
                  : "text-icon hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <Icon
                name={
                  masterMuted
                    ? "volume-mute"
                    : volumeDb < -25
                      ? "volume-low"
                      : "volume-high"
                }
                size={14}
              />
            </button>
            <input
              aria-label="Preview volume"
              type="range"
              min={-60}
              max={0}
              step={1}
              value={volumeDb}
              onChange={(e) => onVolume(Number(e.target.value))}
              className="volume-slider w-16 accent-primary"
              style={{
                background: `linear-gradient(to right, var(--primary) ${volumePercent}%, var(--separator) ${volumePercent}%)`,
              }}
              title={`Volume: ${volumeDb} dB`}
            />
          </div>

          <div className="h-3 w-px bg-separator/60" />

          <span className="whitespace-nowrap font-mono text-[10.5px] tabular-nums text-time">
            Frame{" "}
            <span className="font-medium text-foreground/90">{currentFrame}</span>
            <span className="mx-1 text-frame">/</span>
            <span className="text-frame">{total}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
