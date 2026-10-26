export function TrackHeader({
  label,
  muted,
  onMute,
}: {
  label: string;
  muted?: boolean;
  onMute?: () => void;
}) {
  return (
    <div className={`flex h-10 shrink-0 items-center justify-between gap-1 border-b border-row px-1.5 ${muted ? "opacity-45" : ""}`}>
      <span className="min-w-0 truncate text-[11px] font-medium text-secondary-foreground">
        {label}
      </span>
      {onMute && (
        <button
          type="button"
          aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
          aria-pressed={muted}
          onClick={onMute}
          className={`flex size-5 shrink-0 items-center justify-center rounded-[3px] border text-[11px] font-semibold leading-none ${muted ? "border-primary bg-muted-track text-muted-track-foreground" : "border-control-border text-meta"}`}
        >
          M
        </button>
      )}
    </div>
  );
}
