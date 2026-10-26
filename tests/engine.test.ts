import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  frameCount,
  frameTiming,
  validateProject,
} from "../src/engine/timeline";
import { audioSampleCount } from "../src/engine/audio";
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
test("audio sample count matches every supported frame rate and clips stay on their own tracks", () => {
  for (const fps of [24, 30, 60]) assert.equal(audioSampleCount(8, fps), 384000);
  assert.equal(project.audioTracks?.length, 2);
  assert.throws(() => audioSampleCount(8, 7));
  assert.throws(() =>
    validateProject({
      ...project,
      audioTracks: [
        {
          id: "a1",
          name: "A1",
          clips: [
            { ...project.audioTracks![0].clips[0], start: 5, duration: 4 },
          ],
        },
      ],
    }),
  );
  assert.throws(() =>
    validateProject({
      ...project,
      audioTracks: [
        {
          id: "a1",
          name: "A1",
          clips: [
            { ...project.audioTracks![0].clips[0], id: "one", start: 0, duration: 3 },
            { ...project.audioTracks![0].clips[0], id: "two", start: 2, duration: 2 },
          ],
        },
      ],
    }),
  );
  validateProject({
    ...project,
    audioTracks: [
      {
        id: "a1",
        name: "A1",
        clips: [
          { ...project.audioTracks![0].clips[0], id: "one", start: 0, duration: 2 },
        ],
      },
      {
        id: "a2",
        name: "A2",
        clips: [
          { ...project.audioTracks![0].clips[0], id: "two", start: 1, duration: 2 },
        ],
      },
    ],
  });
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
test("MP4 audio track carries AAC tables without replacing the video track", async () => {
  const mux = new MP4Muxer(1280, 720, 30);
  const asc = new Uint8Array([0x11, 0x90]);
  mux.setAudioPriming(2112);
  mux.add(new Uint8Array([0, 0, 0, 2, 0x65]), true, new Uint8Array([1, 2, 3, 4]));
  mux.addAudio(new Uint8Array([0xaa, 0xbb]), asc, 48000, 1024, 128000);
  mux.addAudio(new Uint8Array([0xcc]), asc, 48000, 1024, 128000);
  const data = new Uint8Array(await mux.finalize().arrayBuffer());
  const view = new DataView(data.buffer);
  const traks: number[] = [];
  const walk = (start: number, end: number) => {
    for (let pos = start; pos + 8 <= end; ) {
      const size = view.getUint32(pos);
      const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
      if (type === "trak") traks.push(pos);
      if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(type))
        walk(pos + 8, pos + size);
      pos += size;
    }
  };
  walk(0, data.length);
  assert.equal(traks.length, 2);
  const text = new TextDecoder().decode(data);
  assert.ok(text.includes("vide"));
  assert.ok(text.includes("soun"));
  assert.ok(data.includes(0x11) && data.includes(0x90));
  let audioMdhd = -1;
  let mediaTime = -1;
  const scan = (start: number, end: number) => {
    for (let pos = start; pos + 8 <= end; ) {
      const size = view.getUint32(pos);
      const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
      if (type === "mdhd" && pos > traks[1]) audioMdhd = pos;
      if (type === "elst") mediaTime = view.getUint32(pos + 20);
      if (["trak", "mdia", "edts"].includes(type)) scan(pos + 8, pos + size);
      pos += size;
    }
  };
  scan(traks[1], traks[1] + view.getUint32(traks[1]));
  assert.equal(view.getUint32(audioMdhd + 20), 48000);
  assert.equal(view.getUint32(audioMdhd + 24), 2048);
  assert.equal(mediaTime, 2112);
  const muxSilent = new MP4Muxer(640, 360, 24);
  assert.throws(() => muxSilent.addAudio(new Uint8Array([1]), new Uint8Array(), 0, 1024, 128000));
  assert.throws(() => muxSilent.addAudio(new Uint8Array([1]), asc, 0, 1024, 128000));
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
