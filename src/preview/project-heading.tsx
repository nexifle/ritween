export function ProjectHeading({
  name,
  ready,
  error,
}: {
  name: string;
  ready: boolean;
  error: string;
}) {
  const status = ready
    ? "Runtime connected"
    : error
      ? "Runtime unavailable"
      : "Preparing preview";
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-separator px-3">
      <div className="min-w-0">
        <p className="truncate text-[11px] leading-4 text-crumb">
          <span>Projects</span>
          <span className="px-1.5 text-slash">/</span>
          <span className="text-strong">Demo composition</span>
        </p>
        <h1 className="truncate text-sm font-medium leading-5 tracking-[-0.2px]">
          {name}
        </h1>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 rounded-sm border border-chip bg-secondary px-2 py-1 text-[11px] text-status">
        <span
          className={`size-1.5 rounded-full ${ready ? "bg-success" : "bg-warning"}`}
        />
        {status}
      </div>
    </div>
  );
}
