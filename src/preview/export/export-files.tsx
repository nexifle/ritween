import { useState } from "react";
import {
  exportJobActive,
  exportJobDownload,
  type ExportJob,
} from "../../engine/export/job";

export function ExportFiles({
  jobs,
  onDelete,
  onCancel,
}: {
  jobs: readonly ExportJob[];
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const bytes = jobs.reduce((total, job) => total + job.bytes, 0);
  return (
    <section
      aria-label="Server exports"
      className="mt-3 border-t border-border pt-2 text-[11px]"
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 py-1 text-left font-semibold cursor-pointer"
      >
        <span>Server exports ({jobs.length})</span>
        <span className="font-mono font-normal text-muted-foreground">
          {(bytes / 1048576).toFixed(1)} MB {expanded ? "−" : "+"}
        </span>
      </button>
      <p className="mt-1 text-muted-foreground leading-relaxed">
        Temporary files are deleted when the server stops normally. Download
        videos you want to keep. Files left after a crash can be downloaded or
        deleted here. Keep at most 4 GiB of completed videos and 50 job records
        per server session; delete older entries before starting more exports.
      </p>
      {expanded && (
        <div className="mt-2 space-y-2">
          {!jobs.length && (
            <p className="text-muted-foreground">No server exports.</p>
          )}
          {jobs.map((job) => (
            <article
              key={job.id}
              data-export-id={job.id}
              className="rounded-sm border border-border bg-secondary/30 p-2"
            >
              <p className="truncate font-medium" title={job.filename}>
                {job.filename}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {job.status}
                {job.recovered
                  ? " · recovered after an unexpected shutdown"
                  : ""}
                {job.bytes > 0
                  ? ` · ${(job.bytes / 1048576).toFixed(1)} MB`
                  : ""}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {new Date(job.createdAt).toLocaleString()}
              </p>
              {job.error && (
                <p className="mt-1 break-words text-muted-foreground">
                  {job.error}
                </p>
              )}
              <div className="mt-1.5 flex gap-3">
                {job.status === "completed" && (
                  <a
                    className="text-primary hover:underline"
                    href={exportJobDownload(job.id)}
                    download={job.filename}
                  >
                    Download
                  </a>
                )}
                {exportJobActive(job) ? (
                  <button
                    type="button"
                    aria-label={`Cancel ${job.filename}`}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => onCancel(job.id)}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete ${job.filename}`}
                    className="text-destructive-foreground hover:underline cursor-pointer"
                    onClick={() => onDelete(job.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
