import { frameCount } from "../engine/timeline";
import { control } from "./controls";
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
  return (
    <>
      <input
        aria-label="Playback scrubber"
        type="range"
        min={0}
        max={duration}
        step={1 / fps}
        value={time}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1">
          <button
            className={control}
            disabled={!ready}
            onClick={() => onSeek(0)}
            aria-label="Restart"
          >
            <Icon name="restart" size={16} />
          </button>
          <button
            className={control}
            disabled={!ready}
            onClick={() => onSeek(time - 1 / fps)}
            aria-label="Previous frame"
          >
            <Icon name="back" size={16} />
          </button>
          <button
            disabled={!ready}
            onClick={onToggle}
            aria-label={playing ? "Pause" : "Play"}
            className="mx-0.5 flex h-7 w-[34px] items-center justify-center rounded-sm bg-play text-play-foreground hover:bg-play-hover disabled:opacity-40"
          >
            <Icon name={playing ? "pause" : "play"} size={17} />
          </button>
          <button
            className={control}
            disabled={!ready}
            onClick={() => onSeek(time + 1 / fps)}
            aria-label="Next frame"
          >
            <Icon name="next" size={16} />
          </button>
        </div>
        <div className="font-mono text-[11px] tabular-nums">
          <span>{clock(time)}</span>
          <span className="mx-2 text-time-slash">/</span>
          <span className="text-time">{clock(duration)}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-time">
          <button
            type="button"
            aria-label={masterMuted ? "Unmute mix" : "Mute mix"}
            aria-pressed={masterMuted}
            onClick={onMasterMute}
            className={`flex h-[22px] w-[22px] items-center justify-center rounded-[3px] border text-[11px] font-semibold ${masterMuted ? "border-primary bg-muted-track text-muted-track-foreground" : "border-control-border text-status"}`}
          >
            M
          </button>
          <input
            aria-label="Preview volume"
            type="range"
            min={-60}
            max={0}
            step={1}
            value={volumeDb}
            onChange={(e) => onVolume(Number(e.target.value))}
            className="w-[88px] accent-primary"
          />
        </div>
        <span className="text-[11px] tabular-nums text-time">
          Frame{" "}
          {Math.min(Math.floor(time * fps), total - 1)
            .toString()
            .padStart(3, "0")}{" "}
          <span className="text-frame">/ {total}</span>
        </span>
      </div>
    </>
  );
}
