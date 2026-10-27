import { Icon } from "../components/icon";

export function TrackHeader({
  label,
  detail,
  muted,
  onMute,
  muteDisabled,
}: {
  label: string;
  detail?: string;
  muted?: boolean;
  onMute?: () => void;
  muteDisabled?: boolean;
}) {
  return (
    <div
      className={`flex h-16 shrink-0 items-center justify-between gap-1 border-b border-row px-1.5 ${muted ? "opacity-45" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <span
          title={label}
          className="block min-w-0 truncate text-[11px] font-medium text-secondary-foreground"
        >
          {label}
        </span>
        <span className="mt-1 block truncate text-[10px] text-meta">
          {detail}
        </span>
      </div>
      {onMute && (
        <button
          type="button"
          aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
          title={muted ? `Unmute ${label}` : `Mute ${label}`}
          aria-pressed={muted}
          onClick={onMute}
          disabled={muteDisabled}
          className={`flex size-5 shrink-0 items-center justify-center rounded-[3px] border text-[11px] font-semibold leading-none ${muted ? "border-primary bg-muted-track text-muted-track-foreground" : "border-control-border text-meta"}`}
        >
          <Icon name={muted ? "volume-mute" : "volume-high"} size={14} />
        </button>
      )}
    </div>
  );
}
