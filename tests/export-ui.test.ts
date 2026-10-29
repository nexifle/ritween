import assert from "node:assert/strict";
import test from "node:test";
import type { ExportJob } from "../src/engine/export/job";
import {
  exportStage,
  formatExportBytes,
  formatExportTime,
} from "../src/preview/export/export-format";

test("export file sizes keep small completed videos readable", () => {
  assert.equal(formatExportBytes(0), "0 B");
  assert.equal(formatExportBytes(512), "512 B");
  assert.equal(formatExportBytes(2048), "2 KB");
  assert.equal(formatExportBytes(1572864), "1.5 MB");
  assert.equal(formatExportBytes(1610612736), "1.5 GB");
});

test("export elapsed and remaining times share a compact finite format", () => {
  assert.equal(formatExportTime(-1), "0s");
  assert.equal(formatExportTime(NaN), "0s");
  assert.equal(formatExportTime(Infinity), "0s");
  assert.equal(formatExportTime(59.9), "59s");
  assert.equal(formatExportTime(125), "2m 5s");
  assert.equal(formatExportTime(3661), "1h 1m 1s");
});

test("export stage labels distinguish snapshot preparation, queueing and saving", () => {
  const job = (status: ExportJob["status"], stages: string[] = []) =>
    ({ status, stages }) as ExportJob;
  assert.equal(exportStage(), "Starting export…");
  assert.equal(exportStage(job("preparing")), "Preparing project…");
  assert.equal(exportStage(job("queued")), "Waiting in queue…");
  assert.equal(exportStage(job("saving")), "Saving MP4…");
  assert.equal(
    exportStage(job("running", ["video-encode", "audio-mix"])),
    "Encoding video + Mixing audio",
  );
  assert.equal(exportStage(job("running", ["mux"])), "Finalizing MP4");
  assert.equal(exportStage(job("running")), "Starting renderer…");
});
