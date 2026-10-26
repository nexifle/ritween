export function LaneBlock({
  start,
  duration,
  total,
  color,
  title,
  detail,
  active,
}: {
  start: number;
  duration: number;
  total: number;
  color: string;
  title: string;
  detail: string;
  active?: boolean;
}) {
  return (
    <div
      className="absolute top-[3px] bottom-[3px] overflow-hidden rounded-[3px] border px-1.5"
      style={{
        left: `${(start / total) * 100}%`,
        width: `${(duration / total) * 100}%`,
        borderColor: active ? color : "var(--clip)",
        backgroundColor: `color-mix(in srgb, ${color} 7.0588%, transparent)`,
      }}
    >
      <div className="truncate text-[11px] font-medium leading-3" style={{ color }}>
        {title}
      </div>
      <p className="truncate font-mono text-[11px] leading-3 text-detail">{detail}</p>
    </div>
  );
}
