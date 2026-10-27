/** Minimal ISO BMFF writer: one AVC track, optional AAC track, one chunk each; Baseline AVC in presentation order.
 * Video timescale is FPS: each sample lasts exactly one tick. moov precedes mdat for progressive playback.
 * In-memory only, 32-bit boxes/offsets: files >= 4 GiB are rejected.
 */
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u8 = (...n: number[]) => new Uint8Array(n);
const u16 = (n: number) => u8(n >>> 8, n);
const u32 = (n: number) => u8(n >>> 24, n >>> 16, n >>> 8, n);
const str = (s: string) => new TextEncoder().encode(s);
const zeros = (n: number) => new Uint8Array(n);
const box = (type: string, ...data: Uint8Array[]) => {
  const size = 8 + data.reduce((n, d) => n + d.length, 0);
  if (size >= 2 ** 32) throw Error("MP4 exceeds 32-bit box limit.");
  return concat(u32(size), str(type), ...data);
};
const full = (
  type: string,
  version: number,
  flags: number,
  ...data: Uint8Array[]
) => box(type, u8(version, flags >>> 16, flags >>> 8, flags), ...data);
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
/** Four-byte expandable size used by common MP4 readers. */
const descriptor = (tag: number, body: Uint8Array) =>
  concat(
    u8(
      tag,
      (body.length >> 21) | 0x80,
      (body.length >> 14) | 0x80,
      (body.length >> 7) | 0x80,
      body.length & 0x7f,
    ),
    body,
  );
const esds = (asc: Uint8Array, bitrate: number) => {
  const specific = descriptor(0x05, asc);
  const config = descriptor(
    0x04,
    concat(u8(0x40, 0x15, 0, 0, 0), u32(bitrate), u32(bitrate), specific),
  );
  const sl = descriptor(0x06, u8(2));
  return full(
    "esds",
    0,
    0,
    descriptor(0x03, concat(u16(2), u8(0), config, sl)),
  );
};
/** stts, stsc, stsz, and stco. Video adds stss; audio does not. */
const sampleTables = (
  samples: Uint8Array[],
  sampleDuration: number,
  chunkOffset: number,
  syncSamples?: readonly number[],
) => {
  const n = samples.length;
  const tables = [
    full("stts", 0, 0, u32(1), u32(n), u32(sampleDuration)),
    full("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1)),
    full("stsz", 0, 0, u32(0), u32(n), ...samples.map((s) => u32(s.length))),
    full("stco", 0, 0, u32(1), u32(chunkOffset)),
  ];
  if (syncSamples)
    tables.push(
      full("stss", 0, 0, u32(syncSamples.length), ...syncSamples.map(u32)),
    );
  return tables;
};
const bytes = (value: AllowSharedBufferSource) =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
    : new Uint8Array(value).slice();
export class MP4Muxer {
  private samples: Uint8Array[] = [];
  private syncSamples: number[] = [];
  private description?: Uint8Array;
  private audio: Uint8Array[] = [];
  private audioDescription?: Uint8Array;
  private audioRate = 0;
  private audioFrame = 0;
  private audioBitrate = 0;
  /** Decoder delay, in audio samples, skipped by the audio edit list. */
  private priming = 0;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    /** With false, the caller hands over immutable, exclusively owned sample buffers. */
    private readonly options: { copySamples?: boolean } = {},
  ) {
    if (
      ![width, height, fps].every((n) => Number.isInteger(n) && n > 0) ||
      width > 65535 ||
      height > 65535
    )
      throw Error("Invalid MP4 dimensions or timescale.");
  }
  add(
    data: Uint8Array,
    key: boolean,
    description?: AllowSharedBufferSource,
    timestamp?: number,
  ) {
    if (!data.length) throw Error("Empty video sample.");
    if (!this.samples.length && !key)
      throw Error("The first video sample must be a keyframe.");
    // Baseline H.264 has no B frames. Fail instead of silently muxing reordered,
    // missing or duplicated frames into a constant-rate presentation timeline.
    if (
      timestamp !== undefined &&
      timestamp !== Math.round((this.samples.length * 1e6) / this.fps)
    )
      throw Error(
        "Video samples must arrive in presentation order at the export frame rate.",
      );
    if (description) {
      const next = bytes(description);
      if (
        this.description &&
        (next.length !== this.description.length ||
          next.some((v, i) => v !== this.description![i]))
      )
        throw Error("AVC configuration changed during export.");
      this.description = next;
    }
    if (key) this.syncSamples.push(this.samples.length + 1);
    this.samples.push(this.options.copySamples === false ? data : data.slice());
  }
  addAudio(
    data: Uint8Array,
    description: AllowSharedBufferSource,
    sampleRate: number,
    frameSamples: number,
    bitrate: number,
  ) {
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(frameSamples) ||
      frameSamples <= 0 ||
      !Number.isInteger(bitrate) ||
      bitrate <= 0
    )
      throw Error("Invalid AAC sample rate, frame size, or bitrate.");
    const next = bytes(description);
    if (!next.length) throw Error("Missing AAC decoder configuration.");
    if (
      this.audioDescription &&
      (next.length !== this.audioDescription.length ||
        next.some((v, i) => v !== this.audioDescription![i]))
    )
      throw Error("AAC configuration changed during export.");
    if (this.audioRate && this.audioRate !== sampleRate)
      throw Error("AAC sample rate changed during export.");
    this.audioDescription = next;
    this.audioRate = sampleRate;
    this.audioFrame = frameSamples;
    this.audioBitrate = bitrate;
    this.audio.push(this.options.copySamples === false ? data : data.slice());
  }
  /** Samples of encoder delay to skip so picture and sound start together. */
  setAudioPriming(samples: number) {
    if (!Number.isInteger(samples) || samples < 0)
      throw Error("Invalid AAC priming.");
    this.priming = samples;
  }
  finalize(): Blob {
    const n = this.samples.length;
    if (!n || !this.description || this.description[0] !== 1)
      throw Error("Missing AVC decoder configuration or samples.");
    const ftyp = box("ftyp", str("isom"), u32(512), str("isomiso2avc1mp41"));
    const videoBytes = this.samples.reduce((v, s) => v + s.length, 0);
    const audioBytes = this.audio.reduce((v, s) => v + s.length, 0);
    if (videoBytes + audioBytes + ftyp.length + 8 >= 2 ** 32)
      throw Error("Export exceeds 4 GiB; choose a smaller resolution.");
    const hasAudio = this.audio.length > 0;
    if (hasAudio && !this.audioDescription)
      throw Error("Missing AAC decoder configuration or samples.");
    let dataOffset = ftyp.length + 8;
    const mvhd = full(
      "mvhd",
      0,
      0,
      u32(0),
      u32(0),
      u32(this.fps),
      u32(n),
      u32(0x10000),
      u16(0x100),
      zeros(10),
      matrix,
      zeros(24),
      u32(hasAudio ? 3 : 2),
    );
    const makeMoov = () =>
      box(
        "moov",
        mvhd,
        this.videoTrack(n, dataOffset),
        ...(hasAudio ? [this.audioTrack(n, dataOffset + videoBytes)] : []),
      );
    // Offsets use fixed-width fields, so the second pass has the same box size.
    const metadataSize = makeMoov().length;
    dataOffset += metadataSize;
    if (dataOffset + videoBytes + audioBytes >= 2 ** 32)
      throw Error("Export exceeds the MP4 32-bit file limit.");
    const moov = makeMoov();
    return new Blob(
      [
        ftyp.buffer,
        moov.buffer,
        concat(u32(videoBytes + audioBytes + 8), str("mdat")).buffer,
        ...this.samples.map((s) => s as Uint8Array<ArrayBuffer>),
        ...this.audio.map((s) => s as Uint8Array<ArrayBuffer>),
      ],
      { type: "video/mp4" },
    );
  }
  private videoTrack(frames: number, chunkOffset: number) {
    const tkhd = full(
      "tkhd",
      0,
      7,
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(frames),
      zeros(8),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      matrix,
      u32(this.width * 65536),
      u32(this.height * 65536),
    );
    const mdhd = full(
      "mdhd",
      0,
      0,
      u32(0),
      u32(0),
      u32(this.fps),
      u32(frames),
      u16(0x55c4),
      u16(0),
    );
    const hdlr = full(
      "hdlr",
      0,
      0,
      u32(0),
      str("vide"),
      zeros(12),
      str("Rimotion Video\0"),
    );
    const avc1 = box(
      "avc1",
      zeros(6),
      u16(1),
      zeros(16),
      u16(this.width),
      u16(this.height),
      u32(0x480000),
      u32(0x480000),
      u32(0),
      u16(1),
      zeros(32),
      u16(24),
      u16(65535),
      box("avcC", this.description!),
    );
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), avc1),
      ...sampleTables(this.samples, 1, chunkOffset, this.syncSamples),
    );
    const dinf = box("dinf", full("dref", 0, 1, u32(1), full("url ", 0, 1)));
    const minf = box("minf", full("vmhd", 0, 1, zeros(8)), dinf, stbl);
    return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  }
  private audioTrack(videoFrames: number, chunkOffset: number) {
    const mediaSamples = this.audio.length * this.audioFrame;
    const tkhd = full(
      "tkhd",
      0,
      7,
      u32(0),
      u32(0),
      u32(2),
      u32(0),
      u32(videoFrames),
      zeros(8),
      u16(0),
      u16(1),
      u16(0x100),
      u16(0),
      matrix,
      u32(0),
      u32(0),
    );
    const mdhd = full(
      "mdhd",
      0,
      0,
      u32(0),
      u32(0),
      u32(this.audioRate),
      u32(mediaSamples),
      u16(0x55c4),
      u16(0),
    );
    const hdlr = full(
      "hdlr",
      0,
      0,
      u32(0),
      str("soun"),
      zeros(12),
      str("Rimotion Audio\0"),
    );
    const mp4a = box(
      "mp4a",
      zeros(6),
      u16(1),
      zeros(8),
      u16(2),
      u16(16),
      zeros(4),
      u32(this.audioRate * 65536),
      esds(this.audioDescription!, this.audioBitrate),
    );
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), mp4a),
      ...sampleTables(this.audio, this.audioFrame, chunkOffset),
    );
    const dinf = box("dinf", full("dref", 0, 1, u32(1), full("url ", 0, 1)));
    const minf = box("minf", full("smhd", 0, 0, u16(0), u16(0)), dinf, stbl);
    const edts =
      this.priming > 0
        ? box(
            "edts",
            full(
              "elst",
              0,
              0,
              u32(1),
              u32(videoFrames),
              u32(this.priming),
              u16(1),
              u16(0),
            ),
          )
        : undefined;
    return box(
      "trak",
      tkhd,
      ...(edts ? [edts] : []),
      box("mdia", mdhd, hdlr, minf),
    );
  }
}
