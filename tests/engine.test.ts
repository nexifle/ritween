import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  frameCount,
  frameTiming,
  validateProject,
} from "../src/engine/timeline";
import { audioSampleCount } from "../src/engine/render/audio";
import {
  assertExportSize,
  defaultExportSize,
  exportSizes,
} from "../src/engine/export/formats/mp4/sizes";
import { MP4Muxer } from "../src/engine/export/formats/mp4/muxer";
import { project } from "../src/project/manifest";

test("export sizes keep any project aspect inside H.264 Level 4.2", () => {
  const pixels = (resolution: readonly [number, number]) =>
    exportSizes(resolution).map((size) => [size.width, size.height]);
  assert.deepEqual(pixels([1280, 720]), [
    [640, 360],
    [1280, 720],
    [1920, 1080],
  ]);
  assert.deepEqual(
    exportSizes([1280, 720]).map((size) => size.name),
    ["360p", "720p", "1080p"],
  );
  assert.deepEqual(pixels([1080, 1920]), [
    [360, 640],
    [720, 1280],
    [1080, 1920],
  ]);
  assert.deepEqual(pixels([1080, 1080]), [
    [360, 360],
    [720, 720],
    [1080, 1080],
  ]);
  assert.deepEqual(pixels([1080, 1350]), [
    [360, 450],
    [720, 900],
    [1080, 1350],
  ]);
  assert.deepEqual(pixels([1440, 1080]), [
    [480, 360],
    [960, 720],
    [1440, 1080],
  ]);
  assert.deepEqual(pixels([2520, 1080]), [
    [840, 360],
    [1680, 720],
  ]);
  assert.deepEqual(pixels([8000, 100]), []);
  assert.equal(defaultExportSize([1080, 1920])?.width, 720);
  assert.equal(defaultExportSize([1280, 720])?.name, "720p");
  assert.equal(defaultExportSize([8000, 100]), undefined);
  const landscape = {
    resolution: [1280, 720] as const,
    aspectRatio: [16, 9] as const,
  };
  const portrait = {
    resolution: [1080, 1920] as const,
    aspectRatio: [9, 16] as const,
  };
  assert.doesNotThrow(() => assertExportSize(landscape, 1920, 1080));
  assert.throws(() => assertExportSize(landscape, 1080, 1920), /16:9/);
  assert.throws(() => assertExportSize(landscape, 800, 600), /16:9/);
  assert.doesNotThrow(() => assertExportSize(portrait, 720, 1280));
  assert.throws(() => assertExportSize(portrait, 1920, 1080), /9:16/);
  assert.doesNotThrow(() =>
    assertExportSize(
      { resolution: [1080, 1350], aspectRatio: [4, 5] },
      1080,
      1350,
    ),
  );
  assert.throws(() => assertExportSize(landscape, 721, 405), /even/);
  assert.throws(() => assertExportSize(landscape, 4096, 2304), /Level 4\.2/);
});
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
  for (const fps of [24, 30, 60])
    assert.equal(audioSampleCount(8, fps), 384000);
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
            {
              ...project.audioTracks![0].clips[0],
              id: "one",
              start: 0,
              duration: 3,
            },
            {
              ...project.audioTracks![0].clips[0],
              id: "two",
              start: 2,
              duration: 2,
            },
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
          {
            ...project.audioTracks![0].clips[0],
            id: "one",
            start: 0,
            duration: 2,
          },
        ],
      },
      {
        id: "a2",
        name: "A2",
        clips: [
          {
            ...project.audioTracks![0].clips[0],
            id: "two",
            start: 1,
            duration: 2,
          },
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
    ["ftyp", "moov", "mdat"],
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
  assert.equal(view.getUint32(find("stco") + 16), top[2].start + 8);
  assert.equal(view.getUint32(find("stts") + 16), 240);
  assert.equal(view.getUint32(find("stts") + 20), 1);
  const sizes = Array.from({ length: 240 }, (_, i) =>
    view.getUint32(find("stsz") + 20 + i * 4),
  );
  assert.equal(
    sizes.reduce((a, b) => a + b, 0),
    top[2].size - 8,
  );
});
test("MP4 audio track carries AAC tables without replacing the video track", async () => {
  const mux = new MP4Muxer(1280, 720, 30);
  const asc = new Uint8Array([0x11, 0x90]);
  mux.setAudioPriming(2112);
  mux.add(
    new Uint8Array([0, 0, 0, 2, 0x65]),
    true,
    new Uint8Array([1, 2, 3, 4]),
  );
  mux.addAudio(new Uint8Array([0xaa, 0xbb]), asc, 48000, 1024, 128000);
  mux.addAudio(new Uint8Array([0xcc]), asc, 48000, 1024, 128000);
  const data = new Uint8Array(await mux.finalize().arrayBuffer());
  const view = new DataView(data.buffer);
  const traks: number[] = [];
  const walk = (start: number, end: number) => {
    for (let pos = start; pos + 8 <= end;) {
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
    for (let pos = start; pos + 8 <= end;) {
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
  assert.throws(() =>
    muxSilent.addAudio(new Uint8Array([1]), new Uint8Array(), 0, 1024, 128000),
  );
  assert.throws(() =>
    muxSilent.addAudio(new Uint8Array([1]), asc, 0, 1024, 128000),
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

test("GOP muxing writes only actual sync samples and rejects broken frame order", async () => {
  const mux = new MP4Muxer(640, 360, 30);
  const config = new Uint8Array([1, 66, 0, 42]);
  const sample = new Uint8Array([0, 0, 0, 1, 0x65]);
  mux.add(sample, true, config, 0);
  sample[4] = 0;
  mux.add(new Uint8Array([0, 0, 0, 1, 0x41]), false, undefined, 33333);
  assert.throws(
    () => mux.add(sample, false, undefined, 33333),
    /presentation order/,
  );
  assert.throws(
    () => mux.add(sample, false, undefined, 100000),
    /presentation order/,
  );
  mux.add(sample, true, undefined, 66667);
  const data = new Uint8Array(await mux.finalize().arrayBuffer());
  const view = new DataView(data.buffer);
  const tables = new Map<string, number>();
  const walk = (start: number, end: number) => {
    for (const b of boxes(data, start, end)) {
      tables.set(b.type, b.start);
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(b.type))
        walk(b.start + 8, b.start + b.size);
    }
  };
  walk(0, data.length);
  const stss = tables.get("stss")!;
  assert.equal(view.getUint32(stss + 12), 2);
  assert.equal(view.getUint32(stss + 16), 1);
  assert.equal(view.getUint32(stss + 20), 3);
  const media = tables.get("mdat")! + 8;
  assert.equal(view.getUint32(tables.get("stco")! + 16), media);
  assert.equal(
    data[media + 4],
    0x65,
    "default ownership protects samples from caller mutations",
  );
});

test("owned muxer samples preserve subarray byte ranges in the final Blob", async () => {
  const mux = new MP4Muxer(640, 360, 30, { copySamples: false });
  const buffer = new Uint8Array([99, 0, 0, 0, 1, 0x65, 99]);
  mux.add(buffer.subarray(1, 6), true, new Uint8Array([1, 66, 0, 42]), 0);
  const data = new Uint8Array(await mux.finalize().arrayBuffer());
  const media = boxes(data).find((box) => box.type === "mdat")!;
  assert.equal(media.size, 13);
  assert.deepEqual(
    data.slice(media.start + 8),
    new Uint8Array([0, 0, 0, 1, 0x65]),
  );
});
