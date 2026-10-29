import type { ExportJob } from "../../engine/export/job";

export function formatExportTime(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours
    ? `${hours}h ${minutes}m ${rest}s`
    : minutes
      ? `${minutes}m ${rest}s`
      : `${rest}s`;
}

export function formatExportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

export function exportStage(job?: ExportJob): string {
  if (!job) return "Starting export…";
  if (job.status === "preparing") return "Preparing project…";
  if (job.status === "queued") return "Waiting in queue…";
  if (job.status === "saving") return "Saving MP4…";
  const labels: Record<string, string> = {
    "audio-mix": "Mixing audio",
    "audio-encode": "Encoding audio",
    "scene-setup": "Preparing scenes",
    "video-encode": "Encoding video",
    mux: "Finalizing MP4",
  };
  return (
    job.stages.map((stage) => labels[stage] ?? stage).join(" + ") ||
    "Starting renderer…"
  );
}
