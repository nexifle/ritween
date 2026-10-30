import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  createExportProgress,
  formatExportResult,
} from "../cli/export-progress.ts";

function fixture({ json = false, isTTY = true, columns = 120 } = {}) {
  let time = 0;
  const writes: string[] = [];
  const stream = {
    isTTY,
    columns,
    write: (text: string) => writes.push(text),
  };
  const progress = createExportProgress({ json, stream, now: () => time });
  return {
    progress,
    stream,
    writes,
    advance: (milliseconds: number) => (time += milliseconds),
    line: () =>
      stripVTControlCharacters(writes.at(-1) ?? "")
        .replaceAll("\r", "")
        .trim(),
  };
}

test("interactive export rewrites two lines with readable parallel stages", (t) => {
  const f = fixture();
  t.after(() => f.progress.stop());
  assert.match(f.line(), /Preparing renderer/);
  f.progress.update(0, 5400);
  f.progress.stage("audio-mix");
  f.progress.stage("scene-setup");
  assert.match(f.line(), /Mixing audio \+ Preparing scenes/);
  f.progress.stageComplete("scene-setup");
  f.progress.stage("video-encode");
  f.advance(10_000);
  f.progress.update(1350, 5400);
  assert.match(f.line(), /25%/);
  assert.match(f.line(), /1,350\/5,400 frames/);
  assert.match(f.line(), /135 fps/);
  assert.match(f.line(), /ETA 30s/);
  assert.match(f.line(), /Mixing audio \+ Encoding video/);
  const [bar, details] = f.line().split("\n");
  assert.match(bar, /^Export \[[=]+[-]+\] 25%$/);
  assert.match(details, /Mixing audio \+ Encoding video/);
  assert.doesNotMatch(bar, /frames|fps|ETA|Encoding/);
  assert.ok(f.writes.every((block) => block.startsWith("\r\u001b[0J")));
  assert.ok(f.writes.every((block) => block.endsWith("\r\u001b[1A")));
  assert.ok(f.writes.every((block) => block.split("\n").length === 2));
});

test("encoding estimates exclude renderer startup and scene preparation", (t) => {
  const f = fixture();
  t.after(() => f.progress.stop());
  f.progress.update(0, 5400);
  f.advance(20_000);
  f.progress.stage("video-encode");
  f.advance(10_000);
  f.progress.update(1350, 5400);
  assert.match(f.line(), /135 fps/);
  assert.match(f.line(), /ETA 30s/);
  assert.match(f.line(), /30s elapsed/);
});

test("completed stages disappear and finalization never claims the file is saved", (t) => {
  const f = fixture();
  t.after(() => f.progress.stop());
  f.progress.stage("video-encode");
  f.progress.stage("audio-encode");
  f.advance(10_000);
  f.progress.update(5400, 5400);
  assert.match(f.line(), /Finishing video/);
  assert.doesNotMatch(f.line(), /ETA|completed|Saved/);
  f.progress.stageComplete("video-encode");
  assert.match(f.line(), /Encoding audio/);
  assert.doesNotMatch(f.line(), /Finishing video/);
  f.progress.stageComplete("audio-encode");
  f.progress.stage("mux");
  assert.match(f.line(), /Finalizing MP4/);
  f.progress.stageComplete("mux");
  f.progress.saving();
  assert.match(f.line(), /Saving file/);
});

test("interactive progress is throttled and adapts to terminal resizing", (t) => {
  const f = fixture();
  t.after(() => f.progress.stop());
  f.progress.stage("video-encode");
  const before = f.writes.length;
  for (let done = 1; done <= 100; done++) f.progress.update(done, 5400);
  assert.equal(f.writes.length, before);
  f.advance(100);
  f.progress.update(101, 5400);
  assert.equal(f.writes.length, before + 1);
  for (const columns of [80, 40, 20, 12, 8, 1, 120]) {
    f.stream.columns = columns;
    f.progress.stage("audio-encode");
    const lines = f.line().split("\n");
    assert.ok(lines.every((line) => line.length < columns));
    if (columns >= 8) {
      assert.equal(lines.length, 2);
      assert.match(lines[0], /\[[=-]+\] ?1%$/);
    }
  }
});

test("narrow terminals keep the bar at zero and one hundred percent", (t) => {
  for (const columns of [8, 12, 20, 40]) {
    const f = fixture({ columns });
    t.after(() => f.progress.stop());
    f.progress.update(0, 5400);
    assert.match(f.line().split("\n")[0], /\[[-]+\] ?0%$/);
    f.progress.stage("video-encode");
    f.progress.update(5400, 5400);
    const lines = f.line().split("\n");
    assert.match(lines[0], /\[[=]+\] ?100%$/);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line.length < columns));
  }
});

test("interactive terminals without reported dimensions use a readable fallback", (t) => {
  const f = fixture({ columns: 0 });
  t.after(() => f.progress.stop());
  assert.match(f.line(), /Preparing renderer/);
  f.progress.stage("video-encode");
  f.advance(1000);
  f.progress.update(50, 100);
  assert.match(f.line(), /50%/);
  assert.ok(
    f
      .line()
      .split("\n")
      .every((line) => line.length < 80),
  );
});

test("interactive progress hides the cursor until both lines are cleared", (t) => {
  const f = fixture();
  t.after(() => f.progress.stop());
  assert.match(f.writes[0], /\u001b\[\?25l/);
  f.progress.stage("video-encode");
  f.advance(1000);
  f.progress.update(50, 100);
  assert.equal((f.writes.join("").match(/\u001b\[\?25l/g) ?? []).length, 1);
  assert.doesNotMatch(f.writes.join(""), /\u001b\[\?25h/);
  f.progress.stop();
  assert.equal(f.writes.at(-1), "\r\u001b[0J\u001b[?25h");
});

test("stop clears both interactive lines once and ignores late browser callbacks", () => {
  const f = fixture();
  f.progress.stop();
  assert.equal(f.writes.at(-1), "\r\u001b[0J\u001b[?25h");
  const before = f.writes.length;
  f.progress.stop();
  f.progress.stage("mux");
  f.progress.stageComplete("mux");
  f.progress.update(5400, 5400);
  f.progress.saving();
  assert.equal(f.writes.length, before);
});

test("non-interactive exports use readable milestones without terminal controls", () => {
  const f = fixture({ isTTY: false });
  f.progress.stage("audio-mix");
  f.progress.stage("scene-setup");
  f.progress.update(0, 100);
  f.progress.update(1, 100);
  f.progress.update(9, 100);
  f.progress.stage("video-encode");
  f.advance(1000);
  f.progress.update(10, 100);
  f.progress.update(19, 100);
  f.progress.update(100, 100);
  f.progress.stageComplete("video-encode");
  f.progress.stage("mux");
  f.progress.saving();
  f.progress.stop();
  const output = f.writes.join("");
  assert.doesNotMatch(output, /[\r\u001b]|audio-mix|scene-setup|video-encode/);
  assert.match(output, /Preparing renderer/);
  assert.match(output, /Mixing audio/);
  assert.match(output, /Preparing scenes/);
  assert.match(output, /10%.*10\/100 frames/);
  assert.equal((output.match(/10%/g) ?? []).length, 1);
  assert.match(output, /Finalizing MP4/);
  assert.match(output, /Saving file/);
  assert.ok(f.writes.every((line) => line.endsWith("\n")));
});

test("JSON retains the existing stage and ten-percent progress event contract", () => {
  const f = fixture({ json: true });
  assert.deepEqual(f.writes, []);
  f.progress.update(0, 5400);
  f.progress.stage("audio-mix");
  f.progress.stageComplete("audio-mix");
  f.progress.update(1, 5400);
  f.progress.update(540, 5400);
  f.progress.update(541, 5400);
  f.progress.update(5400, 5400);
  f.progress.saving();
  f.progress.stop();
  assert.deepEqual(
    f.writes.map((text) => JSON.parse(text)),
    [
      { event: "progress", done: 0, total: 5400, percent: 0 },
      { event: "stage", stage: "audio-mix" },
      { event: "progress", done: 540, total: 5400, percent: 10 },
      { event: "progress", done: 5400, total: 5400, percent: 100 },
    ],
  );
  assert.doesNotMatch(f.writes.join(""), /[\r\u001b]/);
});

test("export ignores invalid progress without emitting NaN or Infinity", (t) => {
  const f = fixture();
  t.after(() => f.progress.stop());
  const before = f.writes.length;
  for (const [done, total] of [
    [0, 0],
    [NaN, 10],
    [1, Infinity],
  ])
    f.progress.update(done, total);
  assert.equal(f.writes.length, before);
});

test("successful exports have a labeled summary with human-readable duration", () => {
  assert.equal(
    formatExportResult({
      output: "/projects/video/output2.mp4",
      width: 1080,
      height: 1920,
      fps: 60,
      frames: 5400,
      duration: 90,
      bytes: 67_035_464,
      elapsedSeconds: 39.27,
    }),
    [
      "Export completed in 39.27s",
      "  Output  /projects/video/output2.mp4",
      "  Video   1080×1920 · 60 FPS · 1m 30s",
      "  Frames  5,400",
      "  Size    63.93 MiB",
    ].join("\n"),
  );
});

test("export summaries format subsecond and hour-long compositions", () => {
  const result = {
    output: "video.mp4",
    width: 320,
    height: 180,
    fps: 30,
    frames: 15,
    duration: 0.5,
    bytes: 1024,
    elapsedSeconds: 0.25,
  };
  assert.match(formatExportResult(result), /30 FPS · 0.5s/);
  assert.match(formatExportResult({ ...result, duration: 3661 }), /1h 1m 1s/);
  assert.match(
    formatExportResult({ ...result, duration: 59.999 }),
    /30 FPS · 1m\n/,
  );
  assert.match(
    formatExportResult({ ...result, duration: 3599.999 }),
    /30 FPS · 1h\n/,
  );
});
