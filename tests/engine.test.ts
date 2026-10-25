import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  frameCount,
  frameTiming,
  validateProject,
} from "../src/engine/timeline";
import { MP4Muxer } from "../src/engine/mp4";
import { project } from "../src/project/manifest";

test("manifest spans eight seconds with exact hard cuts and seekable local time", () => {
  validateProject(project);
  for (const [time, id, local] of [
    [0, "intro", 0],
    [1.999, "intro", 1.999],
    [2, "main", 0],
    [5.2, "main", 3.2],
    [6, "outro", 0],
    [8, "outro", 2],
  ] as const) {
    const e = evaluate(project, time);
    assert.equal(e.entry.id, id);
    assert.ok(Math.abs(e.localTime - local) < 1e-9);
  }
  assert.throws(() => evaluate(project, NaN));
  assert.throws(() =>
    validateProject({
      ...project,
      scenes: [
        { ...project.scenes[0], duration: 3 },
        ...project.scenes.slice(1),
      ],
    }),
  );
});
test("frame schedules are gapless and exact for each supported FPS", () => {
  for (const fps of [24, 30, 60]) {
    const count = frameCount(8, fps);
    assert.equal(count, 8 * fps);
    let end = 0;
    for (let i = 0; i < count; i++) {
      const timing = frameTiming(i, fps);
      assert.equal(timing.timestamp, end);
      end += timing.duration;
    }
    assert.equal(end, 8_000_000);
  }
});
function boxes(data: Uint8Array, start = 0, end = data.length) {
  const list: { type: string; start: number; size: number }[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let p = start; p < end;) {
    const size = view.getUint32(p);
    assert.ok(size >= 8 && p + size <= end);
    list.push({
      type: new TextDecoder().decode(data.slice(p + 4, p + 8)),
      start: p,
      size,
    });
    p += size;
  }
  return list;
}
test("MP4 tables contain 240 sync samples, exact duration and valid media offset", async () => {
  const mux = new MP4Muxer(1280, 720, 30);
  for (let i = 0; i < 240; i++)
    mux.add(
      new Uint8Array([0, 0, 0, 2, 0x65, i]),
      true,
      i === 0 ? new Uint8Array([1, 66, 0, 42, 255, 225, 0, 0]) : undefined,
    );
  const data = new Uint8Array(await mux.finalize().arrayBuffer());
  const top = boxes(data);
  assert.deepEqual(
    top.map((b) => b.type),
    ["ftyp", "mdat", "moov"],
  );
  const view = new DataView(data.buffer);
  const find = (type: string) => {
    const scan = (start: number, end: number): number => {
      for (const b of boxes(data, start, end)) {
        if (b.type === type) return b.start;
        if (["moov", "trak", "mdia", "minf", "stbl"].includes(b.type)) {
          const match = scan(b.start + 8, b.start + b.size);
          if (match >= 0) return match;
        }
      }
      return -1;
    };
    const p = scan(0, data.length);
    assert.ok(p >= 0, type);
    return p;
  };
  assert.equal(view.getUint32(find("mdhd") + 20), 30);
  assert.equal(view.getUint32(find("mdhd") + 24), 240);
  assert.equal(view.getUint32(find("stsz") + 16), 240);
  assert.equal(view.getUint32(find("stss") + 12), 240);
  assert.equal(view.getUint32(find("stco") + 16), top[1].start + 8);
  assert.equal(view.getUint32(find("stts") + 16), 240);
  assert.equal(view.getUint32(find("stts") + 20), 1);
  const sizes = Array.from({ length: 240 }, (_, i) =>
    view.getUint32(find("stsz") + 20 + i * 4),
  );
  assert.equal(
    sizes.reduce((a, b) => a + b, 0),
    top[1].size - 8,
  );
});
test("muxer rejects missing config, non-sync samples and changing AVC config", () => {
  const mux = new MP4Muxer(640, 360, 30);
  assert.throws(() => mux.finalize());
  assert.throws(() => mux.add(new Uint8Array([1]), false));
  mux.add(new Uint8Array([1]), true, new Uint8Array([1, 2]));
  assert.throws(() =>
    mux.add(new Uint8Array([1]), true, new Uint8Array([1, 3])),
  );
});
