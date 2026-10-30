import {
  exportJobActive,
  exportJobDownload,
  type ExportJob,
} from "../../engine/export/job";
import { Icon } from "../components/icon";
import { exportStage, formatExportBytes } from "./export-format";

const action =
  "flex size-6 shrink-0 items-center justify-center rounded-[3px] text-control hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function ExportFiles({
  jobs,
  onDelete,
  onCancel,
}: {
  jobs: readonly ExportJob[];
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  if (!jobs.length)
    return (
      <section
        aria-label="Server exports"
        className="flex h-full min-h-28 flex-col items-center justify-center gap-1 px-4 py-6 text-center"
      >
        <Icon name="film" size={20} className="mb-1 text-meta" />
        <p className="text-[11px] text-label">No exports yet</p>
        <p className="text-[10px] text-meta">
          Export a video from Settings to see it here.
        </p>
      </section>
    );
  const bytes = jobs.reduce((total, job) => total + job.bytes, 0);
  return (
    <section aria-label="Server exports">
      <div className="flex justify-between px-3 pb-1 pt-2 text-[10px] text-meta">
        <span>Recent exports</span>
        <span className="tabular-nums">{formatExportBytes(bytes)} / 4 GB</span>
      </div>
      <div className="divide-y divide-separator/60 px-3">
        {jobs.map((job) => {
          const active = exportJobActive(job);
          const status = active
            ? exportStage(job)
            : job.status === "completed"
              ? "Ready"
              : job.status === "failed"
                ? "Failed"
                : job.status === "interrupted"
                  ? "Interrupted"
                  : "Cancelled";
          return (
            <article key={job.id} data-export-id={job.id} className="py-2.5">
              <div className="flex items-center gap-2">
                <Icon
                  name={
                    job.status === "completed"
                      ? "film"
                      : active
                        ? "export"
                        : "stop"
                  }
                  size={14}
                  className="shrink-0 text-meta"
                />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-[11px] font-medium"
                    title={job.filename}
                  >
                    {job.filename}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[10px] text-meta">
                    <span>
                      {status}
                      {active ? ` ${job.percent}%` : ""}
                    </span>
                    {job.bytes > 0 && (
                      <span>· {formatExportBytes(job.bytes)}</span>
                    )}
                    <span>
                      ·{" "}
                      <time
                        dateTime={new Date(job.createdAt).toISOString()}
                        title={new Date(job.createdAt).toLocaleString()}
                      >
                        {new Date(job.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </span>
                    {job.recovered && (
                      <span title="Recovered after an unexpected shutdown">
                        · Recovered
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {job.status === "completed" && (
                    <a
                      className={action}
                      href={exportJobDownload(job.id)}
                      download={job.filename}
                      title={`Download ${job.filename}`}
                      aria-label={`Download ${job.filename}`}
                    >
                      <Icon name="export" size={14} />
                    </a>
                  )}
                  <button
                    type="button"
                    title={`${active ? "Cancel" : "Delete"} ${job.filename}`}
                    aria-label={`${active ? "Cancel" : "Delete"} ${job.filename}`}
                    className={`${action} hover:bg-destructive hover:text-destructive-foreground`}
                    onClick={() =>
                      active ? onCancel(job.id) : onDelete(job.id)
                    }
                  >
                    <Icon name={active ? "cancel" : "delete"} size={14} />
                  </button>
                </div>
              </div>
              {job.error && job.status !== "cancelled" && (
                <details className="mt-1 pl-5 text-[10px] text-meta">
                  <summary className="cursor-pointer">Error details</summary>
                  <p className="mt-1 break-words text-destructive-foreground">
                    {job.error}
                  </p>
                </details>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
