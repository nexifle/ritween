export function LaneBlock({
  start,
  duration,
  total,
  color,
  title,
  detail,
  active,
  onInspect,
}: {
  start: number;
  duration: number;
  total: number;
  color: string;
  title: string;
  detail: string;
  active?: boolean;
  onInspect?: () => void;
}) {
  return (
    <div
      className="absolute top-[3px] bottom-[3px] overflow-hidden rounded-[3px] border px-1.5"
      style={{
        left: `${(start / total) * 100}%`,
        width: `${(duration / total) * 100}%`,
        borderColor: active ? color : "var(--clip)",
        backgroundColor: `color-mix(in srgb, ${color} var(--clip-fill), transparent)`,
      }}
    >
      <div className="truncate text-[11px] font-medium leading-3" style={{ color }}>
        {title}
      </div>
      {onInspect ? (
        <button
          type="button"
          className="block max-w-full truncate text-left font-mono text-[11px] leading-3 text-detail hover:text-foreground hover:underline"
          aria-label={`View source ${detail}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onInspect();
          }}
        >
          {detail}
        </button>
      ) : (
        <p className="truncate font-mono text-[11px] leading-3 text-detail">
          {detail}
        </p>
      )}
    </div>
  );
}
