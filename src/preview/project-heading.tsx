export function ProjectHeading({
  name,
  ready,
  error,
}: {
  name: string;
  ready: boolean;
  error: string;
}) {
  return (
    <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
      <div>
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-crumb">
          <span>Projects</span>
          <span className="text-slash">/</span>
          <span className="text-strong">Demo composition</span>
        </div>
        <h1 className="text-xl font-medium leading-[1.15] tracking-[-0.4px]">
          {name}
        </h1>
      </div>
      <div className="flex items-center gap-1.5 rounded-sm border border-chip bg-card px-2 py-1 text-[11px] text-status">
        <span
          className={`size-1.5 rounded-full ${ready ? "bg-success" : "bg-warning"}`}
        />
        {ready
          ? "Runtime connected"
          : error
            ? "Runtime unavailable"
            : "Initializing WebGPU"}
      </div>
    </div>
  );
}
