export function LaneBlock({
  start,
  duration,
  total,
  color,
  title,
  detail,
  timing,
  active,
  onInspect,
}: {
  start: number;
  duration: number;
  total: number;
  color: string;
  title: string;
  detail: string;
  timing?: string;
  active?: boolean;
  onInspect?: () => void;
}) {
  return (
    <div
      title={`${title} · ${timing ?? detail}`}
      className="absolute top-1 bottom-1 flex flex-col justify-center overflow-hidden rounded-[3px] border px-1.5"
      style={{
        left: `${(start / total) * 100}%`,
        width: `${(duration / total) * 100}%`,
        borderColor: active ? color : "var(--clip)",
        backgroundColor: `color-mix(in srgb, ${color} var(--clip-fill), transparent)`,
      }}
    >
      <div
        className="truncate text-[11px] font-medium leading-[14px]"
        style={{ color }}
      >
        {title}
      </div>
      {timing && (
        <div className="truncate font-mono text-[10px] leading-4 tabular-nums text-meta">
          {timing}
        </div>
      )}
      {onInspect ? (
        <button
          type="button"
          className="block w-full truncate border-0 bg-transparent p-0 text-left font-mono text-[11px] leading-[14px] text-detail hover:text-foreground hover:underline"
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
        <p className="truncate font-mono text-[11px] leading-[14px] text-detail">
          {detail}
        </p>
      )}
    </div>
  );
}
