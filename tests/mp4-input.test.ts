import assert from "node:assert/strict";
import test from "node:test";
import { parseMp4, parseMp4Metadata } from "../src/engine/decode/formats/mp4";
import { decodeVideoAudio } from "../src/engine/decode/audio-file";
import { openByteSource } from "../src/engine/media/byte-source";

type SampleSpec = {
  data: Uint8Array;
  duration: number;
  compositionOffset?: number;
};
type EditSpec = { duration: number; mediaTime: number };
type TrackSpec = {
  kind: "video" | "audio";
  id?: number;
  timescale?: number;
  samples: SampleSpec[];
  chunks?: number[][];
  syncSamples?: number[] | null;
  edits?: EditSpec[];
  sampleEntryType?: string;
  pasp?: [number, number];
  compositionVersion?: 0 | 1;
  co64?: boolean;
  wideHeaders?: boolean;
};
type FixtureOptions = {
  tracks: TrackSpec[];
  movieTimescale?: number;
  movieDuration?: number;
  movieWide?: boolean;
  fragment?: boolean;
  editRate?: number;
};

const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const u8 = (...values: number[]) => new Uint8Array(values);
const u16 = (value: number) => u8(value >>> 8, value);
const u32 = (value: number) =>
  u8(value >>> 24, value >>> 16, value >>> 8, value);
const u64 = (value: number) => {
  const big = BigInt(value);
  return u8(
    Number((big >> 56n) & 0xffn),
    Number((big >> 48n) & 0xffn),
    Number((big >> 40n) & 0xffn),
    Number((big >> 32n) & 0xffn),
    Number((big >> 24n) & 0xffn),
    Number((big >> 16n) & 0xffn),
    Number((big >> 8n) & 0xffn),
    Number(big & 0xffn),
  );
};
const str = (value: string) => new TextEncoder().encode(value);
const zeros = (length: number) => new Uint8Array(length);
const box = (type: string, ...parts: Uint8Array[]) =>
  concat(
    u32(8 + parts.reduce((sum, part) => sum + part.length, 0)),
    str(type),
    ...parts,
  );
const full = (
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
) => box(type, u8(version, flags >>> 16, flags >>> 8, flags), ...parts);
const matrix = concat(
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);
const descriptor = (tag: number, body: Uint8Array) => {
  assert.ok(body.length < 128);
  return concat(u8(tag, body.length), body);
};
const audioConfig = new Uint8Array([0x11, 0x90]);
const esds = () => {
  const specific = descriptor(0x05, audioConfig);
  const decoderConfig = descriptor(
    0x04,
    concat(u8(0x40, 0x15, 0, 0, 0), u32(128000), u32(128000), specific),
  );
  const sl = descriptor(0x06, u8(2));
  return full(
    "esds",
    0,
    0,
    descriptor(0x03, concat(u16(2), u8(0), decoderConfig, sl)),
  );
};

function groupRuns<T>(values: T[]) {
  const result: { count: number; value: T }[] = [];
  for (const value of values) {
    const previous = result[result.length - 1];
    if (previous && previous.value === value) previous.count++;
    else result.push({ count: 1, value });
  }
  return result;
}

function sampleDescription(track: TrackSpec) {
  const type =
    track.sampleEntryType ?? (track.kind === "video" ? "avc1" : "mp4a");
  if (track.kind === "video") {
    const avc1 = box(
      type,
      zeros(6),
      u16(1),
      zeros(16),
      u16(640),
      u16(360),
      u32(0x480000),
      u32(0x480000),
      u32(0),
      u16(1),
      zeros(32),
      u16(24),
      u16(65535),
      box("avcC", u8(1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68)),
      ...(track.pasp
        ? [box("pasp", u32(track.pasp[0]), u32(track.pasp[1]))]
        : []),
    );
    return full("stsd", 0, 0, u32(1), avc1);
  }
  const mp4a = box(
    type,
    zeros(6),
    u16(1),
    zeros(8),
    u16(2),
    u16(16),
    zeros(4),
    u32(48000 * 65536),
    esds(),
  );
  return full("stsd", 0, 0, u32(1), mp4a);
}

function makeTrack(
  spec: TrackSpec,
  chunkOffsets: number[],
  options: FixtureOptions,
) {
  const timescale = spec.timescale ?? (spec.kind === "video" ? 1000 : 48000);
  const duration = spec.samples.reduce(
    (sum, sample) => sum + sample.duration,
    0,
  );
  const wide = spec.wideHeaders ?? false;
  const mdhd = wide
    ? full(
        "mdhd",
        1,
        0,
        u64(0),
        u64(0),
        u32(timescale),
        u64(duration),
        u16(0x55c4),
        u16(0),
      )
    : full(
        "mdhd",
        0,
        0,
        u32(0),
        u32(0),
        u32(timescale),
        u32(duration),
        u16(0x55c4),
        u16(0),
      );
  const movieTimescale = options.movieTimescale ?? 1000;
  const movieDuration = options.movieDuration ?? 3000;
  const id = spec.id ?? (spec.kind === "video" ? 1 : 2);
  const displayWidth = spec.kind === "video" ? 640 * 65536 : 0;
  const displayHeight = spec.kind === "video" ? 360 * 65536 : 0;
  const tkhd = wide
    ? full(
        "tkhd",
        1,
        7,
        u64(0),
        u64(0),
        u32(id),
        u32(0),
        u64(movieDuration),
        zeros(8),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        matrix,
        u32(displayWidth),
        u32(displayHeight),
      )
    : full(
        "tkhd",
        0,
        7,
        u32(0),
        u32(0),
        u32(id),
        u32(0),
        u32(movieDuration),
        zeros(8),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        matrix,
        u32(displayWidth),
        u32(displayHeight),
      );
  const handler = full(
    "hdlr",
    0,
    0,
    u32(0),
    str(spec.kind === "video" ? "vide" : "soun"),
    zeros(12),
    str(spec.kind === "video" ? "Video\0" : "Audio\0"),
  );
  const timeRuns = groupRuns(spec.samples.map((sample) => sample.duration));
  const stts = full(
    "stts",
    0,
    0,
    u32(timeRuns.length),
    ...timeRuns.map((run) => concat(u32(run.count), u32(run.value))),
  );
  const compositionOffsets = spec.samples.map(
    (sample) => sample.compositionOffset ?? 0,
  );
  const ctts = compositionOffsets.some((value) => value !== 0)
    ? full(
        "ctts",
        spec.compositionVersion ??
          (compositionOffsets.some((value) => value < 0) ? 1 : 0),
        0,
        u32(groupRuns(compositionOffsets).length),
        ...groupRuns(compositionOffsets).map((run) =>
          concat(u32(run.count), u32(run.value)),
        ),
      )
    : undefined;
  const chunks = spec.chunks ?? [spec.samples.map((_, index) => index)];
  const chunkRuns: { first: number; perChunk: number }[] = [];
  chunks.forEach((chunk, index) => {
    const previous = chunkRuns[chunkRuns.length - 1];
    if (!previous || previous.perChunk !== chunk.length)
      chunkRuns.push({ first: index + 1, perChunk: chunk.length });
  });
  const stsc = full(
    "stsc",
    0,
    0,
    u32(chunkRuns.length),
    ...chunkRuns.map((run) =>
      concat(u32(run.first), u32(run.perChunk), u32(1)),
    ),
  );
  const stsz = full(
    "stsz",
    0,
    0,
    u32(0),
    u32(spec.samples.length),
    ...spec.samples.map((sample) => u32(sample.data.length)),
  );
  const offsetsBox = spec.co64
    ? full("co64", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u64))
    : full("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32));
  const syncSamples =
    spec.syncSamples === null
      ? undefined
      : (spec.syncSamples ?? (spec.kind === "video" ? [0] : undefined));
  const stss = syncSamples
    ? full(
        "stss",
        0,
        0,
        u32(syncSamples.length),
        ...syncSamples.map((index) => u32(index + 1)),
      )
    : undefined;
  const stbl = box(
    "stbl",
    sampleDescription(spec),
    stts,
    ...(ctts ? [ctts] : []),
    stsc,
    stsz,
    offsetsBox,
    ...(stss ? [stss] : []),
  );
  const dref = full("dref", 0, 1, u32(1), full("url ", 0, 1));
  const minf = box(
    "minf",
    spec.kind === "video"
      ? full("vmhd", 0, 1, zeros(8))
      : full("smhd", 0, 0, zeros(4)),
    box("dinf", dref),
    stbl,
  );
  const mdia = box("mdia", mdhd, handler, minf);
  let edts: Uint8Array | undefined;
  if (spec.edits) {
    const editVersion = wide ? 1 : 0;
    const entries = spec.edits.map((edit) =>
      editVersion === 0
        ? concat(
            u32(edit.duration),
            u32(edit.mediaTime),
            u16(options.editRate ?? 1),
            u16(0),
          )
        : concat(
            u64(edit.duration),
            u64(edit.mediaTime),
            u16(options.editRate ?? 1),
            u16(0),
          ),
    );
    edts = box(
      "edts",
      full("elst", editVersion, 0, u32(entries.length), ...entries),
    );
  }
  return box("trak", tkhd, ...(edts ? [edts] : []), mdia);
}

function makeFixture(options: FixtureOptions) {
  const movieTimescale = options.movieTimescale ?? 1000;
  const movieDuration = options.movieDuration ?? 3000;
  const ftyp = box("ftyp", str("isom"), u32(512), str("isomiso2mp41"));
  const mvhd = options.movieWide
    ? full(
        "mvhd",
        1,
        0,
        u64(0),
        u64(0),
        u32(movieTimescale),
        u64(movieDuration),
        u32(0x10000),
        u16(0x100),
        zeros(10),
        matrix,
        zeros(24),
        u32(3),
      )
    : full(
        "mvhd",
        0,
        0,
        u32(0),
        u32(0),
        u32(movieTimescale),
        u32(movieDuration),
        u32(0x10000),
        u16(0x100),
        zeros(10),
        matrix,
        zeros(24),
        u32(3),
      );
  const makeMoov = (offsets: number[][]) =>
    box(
      "moov",
      mvhd,
      ...options.tracks.map((track, index) =>
        makeTrack(track, offsets[index], options),
      ),
    );
  const emptyOffsets = options.tracks.map((track) =>
    new Array(
      (track.chunks ?? [track.samples.map((_, index) => index)]).length,
    ).fill(0),
  );
  const placeholderMoov = makeMoov(emptyOffsets);
  let cursor = ftyp.length + placeholderMoov.length + 8;
  const chunkOffsets: number[][] = [];
  const mediaParts: Uint8Array[] = [];
  for (const track of options.tracks) {
    const chunks = track.chunks ?? [track.samples.map((_, index) => index)];
    const trackOffsets: number[] = [];
    for (const chunk of chunks) {
      trackOffsets.push(cursor);
      for (const sampleIndex of chunk) {
        const data = track.samples[sampleIndex].data;
        mediaParts.push(data);
        cursor += data.length;
      }
    }
    chunkOffsets.push(trackOffsets);
  }
  const moov = makeMoov(chunkOffsets);
  assert.equal(moov.length, placeholderMoov.length);
  const mdat = box("mdat", concat(...mediaParts));
  const pieces = [ftyp, moov, mdat];
  if (options.fragment) pieces.push(box("moof", full("mfhd", 0, 0, u32(1))));
  return concat(...pieces).buffer;
}

const videoTrack = (overrides: Partial<TrackSpec> = {}): TrackSpec => ({
  kind: "video",
  timescale: 1000,
  samples: [
    { data: u8(0x11, 0x12), duration: 1000 },
    { data: u8(0x21, 0x22, 0x23), duration: 1000 },
    { data: u8(0x31), duration: 1000 },
  ],
  syncSamples: [0, 2],
  ...overrides,
});
const audioTrack = (overrides: Partial<TrackSpec> = {}): TrackSpec => ({
  kind: "audio",
  timescale: 48000,
  samples: [
    { data: u8(0xa1), duration: 1024 },
    { data: u8(0xa2, 0xa3), duration: 1024 },
    { data: u8(0xa4), duration: 1024 },
  ],
  ...overrides,
});

function walkBoxes(
  data: Uint8Array,
  start = 0,
  end = data.length,
): { type: string; start: number; end: number }[] {
  const result: { type: string; start: number; end: number }[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = start; offset < end;) {
    const size = view.getUint32(offset);
    assert.ok(
      size >= 8 && offset + size <= end,
      `bad fixture box at ${offset}`,
    );
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    result.push({ type, start: offset, end: offset + size });
    if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(type))
      result.push(...walkBoxes(data, offset + 8, offset + size));
    offset += size;
  }
  return result;
}

function findBox(data: Uint8Array, type: string) {
  const found = walkBoxes(data).find((item) => item.type === type);
  assert.ok(found, `missing fixture ${type}`);
  return found!;
}

test("metadata-only parser matches full MP4 without allocating media payload", () => {
  const fixture = makeFixture({ tracks: [videoTrack(), audioTrack()] });
  const view = new DataView(fixture);
  let moov: ArrayBuffer | undefined;
  const mdats: { start: number; end: number }[] = [];
  for (let at = 0; at < fixture.byteLength;) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...new Uint8Array(fixture, at + 4, 4));
    if (type === "moov") moov = fixture.slice(at, at + size);
    if (type === "mdat") mdats.push({ start: at + 8, end: at + size });
    at += size;
  }
  assert.ok(moov);
  assert.deepEqual(
    parseMp4Metadata(moov, mdats, fixture.byteLength),
    parseMp4(fixture),
  );
  assert.throws(
    () => parseMp4Metadata(moov, [{ start: -1, end: 10 }], fixture.byteLength),
    /bounds/,
  );
  assert.throws(
    () => parseMp4Metadata(moov, [...mdats, ...mdats], fixture.byteLength),
    /bounds/,
  );
  assert.throws(
    () => parseMp4Metadata(moov, [{ start: 0, end: 1 }], fixture.byteLength),
    /outside every mdat/,
  );
  assert.throws(
    () => parseMp4Metadata(fixture, mdats, fixture.byteLength),
    /exactly one moov/,
  );
});

test("linked MP4 audio uses byte-source reads only when range mode is enabled", async () => {
  const samples = audioTrack().samples;
  samples[0].data = new Uint8Array(512 * 2 ** 10 + 1).fill(0xa1);
  const fixture = makeFixture({
    tracks: [audioTrack({ samples })],
  });
  const previousFetch = globalThis.fetch;
  const previousGlobals = new Map(
    [
      "location",
      "__ritweenRangeVideo",
      "AudioDecoder",
      "EncodedAudioChunk",
    ].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  class FakeEncodedAudioChunk {
    timestamp: number;
    data: Uint8Array;

    constructor(init: EncodedAudioChunkInit) {
      this.timestamp = init.timestamp;
      this.data = new Uint8Array(init.data as Uint8Array);
    }
  }
  class FakeAudioDecoder {
    static async isConfigSupported(config: AudioDecoderConfig) {
      return { supported: true, config };
    }

    decodeQueueSize = 0;
    state: AudioDecoderState = "unconfigured";
    private output: (data: AudioData) => void;

    constructor(init: AudioDecoderInit) {
      this.output = init.output;
    }

    configure() {
      this.state = "configured";
    }

    decode(chunk: EncodedAudioChunk) {
      const encoded = chunk as unknown as FakeEncodedAudioChunk;
      const value = encoded.data[0] / 255;
      this.output({
        numberOfChannels: 2,
        sampleRate: 48_000,
        numberOfFrames: 1024,
        timestamp: encoded.timestamp,
        copyTo(plane: Float32Array) {
          plane.fill(value);
        },
        close() {},
      } as unknown as AudioData);
    }

    flush() {
      return Promise.resolve();
    }

    close() {
      this.state = "closed";
    }
  }

  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://studio.example/editor" },
    });
    Object.defineProperty(globalThis, "AudioDecoder", {
      configurable: true,
      writable: true,
      value: FakeAudioDecoder,
    });
    Object.defineProperty(globalThis, "EncodedAudioChunk", {
      configurable: true,
      writable: true,
      value: FakeEncodedAudioChunk,
    });
    for (const rangeEnabled of [false, true]) {
      const requests: (string | null)[] = [];
      Object.defineProperty(globalThis, "__ritweenRangeVideo", {
        configurable: true,
        writable: true,
        value: rangeEnabled,
      });
      globalThis.fetch = (async (_input, init) => {
        const range = new Headers(init?.headers).get("range");
        requests.push(range);
        if (!range) return new Response(fixture.slice(0));
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        assert.ok(match);
        const start = Number(match[1]);
        const end = Number(match[2]) + 1;
        return new Response(fixture.slice(start, end), {
          status: 206,
          headers: {
            etag: '"audio-v1"',
            "content-range": `bytes ${start}-${end - 1}/${fixture.byteLength}`,
          },
        });
      }) as typeof fetch;
      const planes: Float32Array[] = [];
      const context = {
        createBuffer(channels: number, frames: number, sampleRate: number) {
          planes.length = 0;
          for (let channel = 0; channel < channels; channel++)
            planes.push(new Float32Array(frames));
          return {
            duration: frames / sampleRate,
            getChannelData(channel: number) {
              return planes[channel];
            },
          } as AudioBuffer;
        },
      } as unknown as BaseAudioContext;
      const decoded = await decodeVideoAudio("/audio.mp4", context, 0, 0.05);
      assert.ok(decoded);
      const pcm = decoded.getChannelData(0);
      assert.ok(Math.abs(pcm[0] - 0xa1 / 255) < 1e-7);
      assert.ok(Math.abs(pcm[1024] - 0xa2 / 255) < 1e-7);
      assert.ok(Math.abs(pcm[2048] - 0xa4 / 255) < 1e-7);
      if (rangeEnabled) {
        assert.ok(requests.length > 1);
        assert.ok(
          requests.every((range) => range !== null),
          JSON.stringify(requests),
        );
      } else {
        assert.deepEqual(requests, [null]);
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("shared byte-source parsing isolates track roots and survives owner disposal", async () => {
  const fixture = makeFixture({ tracks: [audioTrack()] });
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  let requests = 0;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://studio.example/editor" },
  });
  globalThis.fetch = (async () => {
    requests++;
    return new Response(fixture.slice(0));
  }) as typeof fetch;
  try {
    const [first, second] = await Promise.all([
      openByteSource("/shared-audio.mp4"),
      openByteSource("https://studio.example/shared-audio.mp4"),
    ]);
    try {
      assert.equal(requests, 1);
      const parsedFirst = first.parse();
      const parsedSecond = second.parse();
      const firstTrack = parsedFirst.tracks[0];
      const secondTrack = parsedSecond.tracks[0];
      assert.notStrictEqual(parsedFirst, parsedSecond);
      assert.notStrictEqual(parsedFirst.tracks, parsedSecond.tracks);
      assert.notStrictEqual(firstTrack, secondTrack);
      assert.strictEqual(firstTrack.samples, secondTrack.samples);
      const sharedSamples = secondTrack.samples;
      const sample = sharedSamples[0];

      firstTrack.samples = [];
      assert.strictEqual(secondTrack.samples, sharedSamples);
      assert.equal(secondTrack.samples.length, 3);
      first.dispose();
      const parsedAfterDispose = second.parse();
      assert.notStrictEqual(parsedAfterDispose.tracks[0], secondTrack);
      assert.strictEqual(parsedAfterDispose.tracks[0].samples, sharedSamples);
      assert.deepEqual(
        await second.read(sample.offset, sample.offset + sample.size),
        new Uint8Array(fixture, sample.offset, sample.size),
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("parses AVC and AAC tracks, descriptions, timing, sample ranges, and sync flags", () => {
  const fixture = makeFixture({
    tracks: [
      videoTrack({
        samples: [
          { data: u8(1, 2), duration: 1000 },
          { data: u8(3, 4, 5), duration: 1000, compositionOffset: 200 },
          { data: u8(6), duration: 1000, compositionOffset: -100 },
        ],
      }),
      audioTrack(),
    ],
  });
  const parsed = parseMp4(fixture);
  assert.equal(parsed.duration, 3);
  assert.equal(parsed.tracks.length, 2);
  const [video, audio] = parsed.tracks;
  assert.equal(video.kind, "video");
  assert.equal(video.id, 1);
  assert.equal(video.codec, "avc1.42001f");
  assert.deepEqual(
    video.description.slice(0, 4),
    new Uint8Array([1, 0x42, 0, 0x1f]),
  );
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.deepEqual(
    video.samples.map((sample) => sample.timestamp),
    [0, 1.2, 1.9],
  );
  assert.deepEqual(
    video.samples.map((sample) => sample.decodeTimestamp),
    [0, 1, 2],
  );
  assert.deepEqual(
    video.samples.map((sample) => sample.key),
    [true, false, true],
  );
  assert.equal(audio.kind, "audio");
  assert.equal(audio.codec, "mp4a.40.2");
  assert.deepEqual(audio.description, audioConfig);
  assert.equal(audio.channels, 2);
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.samples.length, 3);
  assert.ok(audio.samples.every((sample) => sample.key));
  const bytes = new Uint8Array(fixture);
  assert.deepEqual(
    bytes.slice(
      video.samples[1].offset,
      video.samples[1].offset + video.samples[1].size,
    ),
    new Uint8Array([3, 4, 5]),
  );
});

test("expands variable stsc chunk runs and supports co64 plus version-1 clocks", () => {
  const fixture = makeFixture({
    movieWide: true,
    tracks: [
      videoTrack({
        chunks: [[0, 1], [2]],
        co64: true,
        wideHeaders: true,
      }),
    ],
  });
  const parsed = parseMp4(fixture);
  assert.equal(parsed.duration, 3);
  assert.equal(parsed.tracks[0].samples.length, 3);
  const samples = parsed.tracks[0].samples;
  assert.equal(samples[1].offset, samples[0].offset + samples[0].size);
  assert.ok(samples[2].offset > samples[1].offset);
  assert.deepEqual(
    samples.map((sample) => sample.timestamp),
    [0, 1, 2],
  );
});

test("maps an empty edit and media trim onto the shared movie origin", () => {
  const fixture = makeFixture({
    tracks: [
      audioTrack({
        wideHeaders: true,
        edits: [
          { duration: 250, mediaTime: -1 },
          { duration: 64, mediaTime: 1024 },
        ],
      }),
    ],
  });
  const parsed = parseMp4(fixture);
  const track = parsed.tracks[0];
  const samples = track.samples;
  assert.equal(
    samples.length,
    3,
    "edit preroll remains available to the decoder",
  );
  assert.equal(track.presentationStart, 0.25);
  assert.ok(Math.abs(track.presentationEnd - 0.314) < 1e-12);
  assert.ok(Math.abs(samples[0].timestamp - (0.25 - 1024 / 48000)) < 1e-12);
  assert.ok(
    Math.abs(samples[0].decodeTimestamp - (0.25 - 1024 / 48000)) < 1e-12,
  );
  assert.ok(Math.abs(samples[0].duration - 1024 / 48000) < 1e-12);
  assert.equal(samples[1].timestamp, 0.25);
  assert.ok(Math.abs(samples[2].timestamp - (0.25 + 1024 / 48000)) < 1e-12);
});

test("supports a media-only edit and unsigned version-0 composition offsets", () => {
  const fixture = makeFixture({
    tracks: [
      videoTrack({
        samples: [
          { data: u8(1), duration: 1000, compositionOffset: 100 },
          { data: u8(2), duration: 1000, compositionOffset: 200 },
          { data: u8(3), duration: 1000 },
        ],
        compositionVersion: 0,
        edits: [{ duration: 1500, mediaTime: 1000 }],
      }),
    ],
  });
  const track = parseMp4(fixture).tracks[0];
  const samples = track.samples;
  assert.deepEqual(
    samples.map((sample) => sample.timestamp),
    [-0.9, 0.2, 1],
  );
  assert.deepEqual(
    samples.map((sample) => sample.duration),
    [1, 1, 1],
  );
  assert.equal(track.presentationStart, 0);
  assert.equal(track.presentationEnd, 1.5);
});

test("accepts absent stss as all-sync and validates sample extents inside mdat", () => {
  const fixture = makeFixture({ tracks: [videoTrack({ syncSamples: null })] });
  const parsed = parseMp4(fixture);
  assert.ok(parsed.tracks[0].samples.every((sample) => sample.key));
  const corrupt = new Uint8Array(fixture.slice(0));
  const stco = findBox(corrupt, "stco");
  new DataView(corrupt.buffer).setUint32(stco.start + 16, corrupt.length - 1);
  assert.throws(() => parseMp4(corrupt.buffer), /outside every mdat/);
});

test("rejects invalid boxes, sample-table counts, fragments, encryption, and codecs", () => {
  const base = makeFixture({ tracks: [videoTrack()] });
  const badSize = new Uint8Array(base.slice(0));
  const moov = findBox(badSize, "moov");
  new DataView(badSize.buffer).setUint32(moov.start, 0xfffffff0);
  assert.throws(() => parseMp4(badSize.buffer), /extends past its parent/);

  const badStsz = new Uint8Array(base.slice(0));
  const stsz = findBox(badStsz, "stsz");
  new DataView(badStsz.buffer).setUint32(stsz.start + 16, 0xffffffff);
  assert.throws(
    () => parseMp4(badStsz.buffer),
    /sample count exceeds parser limit/,
  );

  const badStts = new Uint8Array(base.slice(0));
  const stts = findBox(badStts, "stts");
  new DataView(badStts.buffer).setUint32(stts.start + 16, 2);
  assert.throws(() => parseMp4(badStts.buffer), /stts count does not match/);

  const badStsc = new Uint8Array(base.slice(0));
  const stsc = findBox(badStsc, "stsc");
  new DataView(badStsc.buffer).setUint32(stsc.start + 20, 4);
  assert.throws(() => parseMp4(badStsc.buffer), /stsc maps more samples/);

  const externalReference = new Uint8Array(base.slice(0));
  const stsd = findBox(externalReference, "stsd");
  new DataView(externalReference.buffer).setUint16(stsd.start + 30, 2);
  assert.throws(
    () => parseMp4(externalReference.buffer),
    /external media data references/,
  );

  assert.throws(
    () => parseMp4(makeFixture({ tracks: [videoTrack()], fragment: true })),
    /fragmented/,
  );
  assert.throws(
    () =>
      parseMp4(
        makeFixture({ tracks: [videoTrack({ sampleEntryType: "encv" })] }),
      ),
    /encrypted/,
  );
  assert.throws(
    () =>
      parseMp4(
        makeFixture({ tracks: [videoTrack({ sampleEntryType: "hvc1" })] }),
      ),
    /unsupported video sample entry/,
  );
});

test("caps the total number of parsed boxes across the entire input", () => {
  const count = 100_001;
  const tinyBoxes = new Uint8Array(count * 8);
  const view = new DataView(tinyBoxes.buffer);
  for (let i = 0; i < count; i++) {
    const offset = i * 8;
    view.setUint32(offset, 8);
    tinyBoxes.set(str("free"), offset + 4);
  }
  const input = concat(
    tinyBoxes,
    new Uint8Array(makeFixture({ tracks: [videoTrack()] })),
  );
  assert.throws(() => parseMp4(input.buffer), /box count exceeds parser limit/);
});

test("rejects unsupported edit rates, malformed ctts, and mismatched AAC config", () => {
  assert.throws(
    () =>
      parseMp4(
        makeFixture({
          tracks: [audioTrack({ edits: [{ duration: 64, mediaTime: 0 }] })],
          editRate: 2,
        }),
      ),
    /rate 1/,
  );

  const cttsFixture = makeFixture({
    tracks: [
      videoTrack({
        samples: [
          { data: u8(1), duration: 1000, compositionOffset: 50 },
          { data: u8(2), duration: 1000, compositionOffset: 50 },
          { data: u8(3), duration: 1000 },
        ],
      }),
    ],
  });
  const badCtts = new Uint8Array(cttsFixture.slice(0));
  const ctts = findBox(badCtts, "ctts");
  new DataView(badCtts.buffer).setUint32(ctts.start + 16, 1);
  assert.throws(() => parseMp4(badCtts.buffer), /ctts count does not match/);

  const badAac = new Uint8Array(makeFixture({ tracks: [audioTrack()] }));
  const ascByte = badAac.findIndex(
    (value, index) => value === 0x11 && badAac[index + 1] === 0x90,
  );
  assert.notEqual(ascByte, -1);
  badAac[ascByte] = 0x10;
  assert.throws(
    () => parseMp4(badAac.buffer),
    /does not match mp4a sample entry/,
  );
});

test("rejects track rotation and non-square sample aspect ratios", () => {
  const squareAspect = makeFixture({ tracks: [videoTrack({ pasp: [1, 1] })] });
  assert.equal(parseMp4(squareAspect).tracks[0].width, 640);
  assert.throws(
    () => parseMp4(makeFixture({ tracks: [videoTrack({ pasp: [4, 3] })] })),
    /non-square pasp/,
  );

  const rotated = new Uint8Array(makeFixture({ tracks: [videoTrack()] }));
  const tkhd = findBox(rotated, "tkhd");
  new DataView(rotated.buffer).setUint32(tkhd.start + 48, 0);
  assert.throws(() => parseMp4(rotated.buffer), /non-identity tkhd matrix/);
});

test("rejects truncation, invalid input type, and unsupported edit-list shapes", () => {
  const fixture = makeFixture({ tracks: [videoTrack()] });
  assert.throws(
    () => parseMp4(fixture.slice(0, 20)),
    /extends past its parent/,
  );
  assert.throws(
    () => parseMp4(new Uint8Array([1, 2, 3]).buffer),
    /truncated box header/,
  );
  assert.throws(
    () => parseMp4(new Uint8Array([1, 2, 3]) as unknown as ArrayBuffer),
    /ArrayBuffer/,
  );
  assert.throws(
    () =>
      parseMp4(
        makeFixture({
          tracks: [audioTrack({ edits: [{ duration: 64, mediaTime: -1 }] })],
        }),
      ),
    /media edit/,
  );
});
