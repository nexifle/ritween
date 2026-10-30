import {
  exportJobActive,
  exportJobDownload,
  type ExportJob,
} from "../../engine/export/job";
import { Icon } from "../components/icon";
import {
  exportStage,
  formatExportBytes,
  formatExportTime,
} from "./export-format";

const primary =
  "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[3px] bg-primary px-3 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45";

export function ExportStatus({
  job,
  exporting,
  ready,
  onExport,
  onCancel,
}: {
  job?: ExportJob;
  exporting: boolean;
  ready: boolean;
  onExport: () => void;
  onCancel: () => void;
}) {
  if (exporting) {
    const active = job && exportJobActive(job) ? job : undefined;
    const percent = active?.percent ?? 0;
    const stage = exportStage(active);
    const finishing =
      active?.status === "saving" ||
      (active && active.total > 0 && active.done >= active.total);
    return (
      <section
        aria-label="Export activity"
        aria-busy="true"
        className="space-y-2"
      >
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          <span
            className="min-w-0 flex-1 truncate font-medium text-foreground"
            title={stage}
          >
            {stage}
          </span>
          <span className="font-mono tabular-nums text-emphasis">
            {percent}%
          </span>
          <button
            type="button"
            onClick={onCancel}
            disabled={!active}
            title="Cancel export"
            aria-label="Cancel export"
            className="flex size-6 shrink-0 items-center justify-center rounded-[3px] text-control hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          >
            <Icon name="cancel" size={13} />
          </button>
        </div>
        <div
          role="progressbar"
          aria-label="Export progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent} percent, ${active?.done ?? 0} of ${active?.total ?? 0} frames`}
          title={`${stage} · ${percent}%`}
          className="h-1 overflow-hidden rounded-full bg-separator"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums text-meta">
          <span>
            {(active?.done ?? 0).toLocaleString()} /{" "}
            {(active?.total ?? 0).toLocaleString()} f ·{" "}
            {formatExportTime(active?.elapsedSeconds ?? 0)}
          </span>
          <span>
            {finishing
              ? "Finishing…"
              : active?.etaSeconds != null
                ? `~${formatExportTime(Math.max(1, active.etaSeconds))} left`
                : "Estimating…"}
          </span>
        </div>
      </section>
    );
  }

  const complete = job?.status === "completed";
  const failed = job?.status === "failed" || job?.status === "interrupted";
  return (
    <div className="space-y-2.5">
      {job && (
        <div role="status" className="space-y-1">
          <div className="flex items-center gap-1.5 text-[11px]">
            <Icon
              name={complete ? "check" : "stop"}
              size={13}
              className="shrink-0 text-meta"
            />
            <span className="min-w-0 flex-1 font-medium">
              {complete
                ? "Your video is ready"
                : job.status === "cancelled"
                  ? "Export cancelled"
                  : job.status === "interrupted"
                    ? "Export interrupted"
                    : "Export failed"}
            </span>
            {complete && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-meta">
                {formatExportBytes(job.bytes)}
              </span>
            )}
          </div>
          {complete && (
            <p className="pl-5 text-[10px] text-meta">
              {job.done.toLocaleString()} frames ·{" "}
              {formatExportTime(job.elapsedSeconds)} elapsed
            </p>
          )}
          {failed && (
            <p
              className="line-clamp-2 text-[11px] text-destructive-foreground"
              title={job.error}
            >
              {job.error}
            </p>
          )}
        </div>
      )}
      <div className="flex gap-1.5">
        {complete && (
          <a
            href={exportJobDownload(job.id)}
            download={job.filename}
            className={primary}
          >
            <Icon name="export" size={13} />
            <span>Download MP4</span>
          </a>
        )}
        <button
          type="button"
          onClick={onExport}
          disabled={!ready}
          aria-label="Export Video"
          title={complete ? "Export again with current settings" : undefined}
          className={
            complete
              ? "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[3px] border border-control-border px-2.5 text-[11px] text-control hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
              : primary
          }
        >
          <Icon name={job ? "restart" : "export"} size={13} />
          <span>
            {complete
              ? "Export again"
              : failed
                ? "Retry export"
                : "Export video"}
          </span>
        </button>
      </div>
    </div>
  );
}
