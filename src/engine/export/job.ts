import type { ProjectSettings } from "../types";

export type ExportJobStatus =
  | "preparing"
  | "queued"
  | "running"
  | "saving"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface ExportJob {
  id: string;
  name: string;
  filename: string;
  status: ExportJobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  stages: string[];
  percent: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  bytes: number;
  error: string;
  recovered: boolean;
}

export interface ExportJobRequest {
  id: string;
  name: string;
  settings: ProjectSettings;
}

export function exportJobActive(job: ExportJob) {
  return ["preparing", "queued", "running", "saving"].includes(job.status);
}

export const exportJobDownload = (id: string) =>
  `/__ritween/exports/${encodeURIComponent(id)}/file`;
