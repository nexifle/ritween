import { useEffect, useRef, useState } from "react";
import type { ProjectSettings } from "../../engine/types";
import {
  exportJobActive,
  exportJobDownload,
  type ExportJob,
} from "../../engine/export/job";

/** Reconnect to server-owned work; unmounting only closes the event stream. */
export function useExportJobs() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [connected, setConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const submitted = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const events = new EventSource("/__ritween/exports/events");
    events.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        if (!Array.isArray(snapshot.jobs))
          throw Error("Invalid export status.");
        setJobs(snapshot.jobs);
        setConnected(true);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    };
    events.onerror = () => setConnected(false);
    return () => {
      alive.current = false;
      events.close();
    };
  }, []);
  useEffect(() => {
    const job = jobs.find((job) => job.id === submitted.current);
    if (!job || job.status !== "completed") return;
    submitted.current = null;
    // Only the tab that submitted this job starts an automatic download.
    const link = document.createElement("a");
    link.href = exportJobDownload(job.id);
    link.download = job.filename;
    link.click();
  }, [jobs]);

  const command = async (url: string, method: string, body?: object) => {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(
        result.error ?? "The export server could not complete the request.",
      );
    if (alive.current && result.jobs) setJobs(result.jobs);
    return result;
  };
  const action = async (url: string, method: string) => {
    setError("");
    try {
      await command(url, method);
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : String(error));
    }
  };
  const start = async (name: string, settings: ProjectSettings) => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    const id = crypto.randomUUID();
    submitted.current = id;
    try {
      const result = await command("/__ritween/exports", "POST", {
        id,
        name,
        settings,
      });
      if (alive.current)
        setJobs((current) =>
          current.some((job) => job.id === id)
            ? current
            : [result.job, ...current],
        );
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
      if (alive.current) setSubmitting(false);
    }
  };
  const current =
    jobs.find((job) => job.status === "running" || job.status === "saving") ??
    jobs.filter(exportJobActive).at(-1) ??
    jobs[0];
  return {
    jobs,
    current,
    connected,
    submitting,
    error,
    exporting: submitting || jobs.some(exportJobActive),
    start,
    cancel: (id: string) => action(`/__ritween/exports/${id}/cancel`, "POST"),
    remove: (id: string) => action(`/__ritween/exports/${id}`, "DELETE"),
  };
}
