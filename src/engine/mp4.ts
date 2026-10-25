/** Minimal ISO BMFF writer: one AVC track, one chunk, all sync samples, no B frames.
 * Timescale is FPS: each sample lasts exactly one tick. mdat precedes moov.
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
export class MP4Muxer {
  private samples: Uint8Array[] = [];
  private description?: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly fps: number,
  ) {
    if (
      ![width, height, fps].every((n) => Number.isInteger(n) && n > 0) ||
      width > 65535 ||
      height > 65535
    )
      throw Error("Invalid MP4 dimensions or timescale.");
  }
  add(data: Uint8Array, key: boolean, description?: AllowSharedBufferSource) {
    if (!key) throw Error("This muxer requires all-keyframe H.264.");
    if (description) {
      const next = ArrayBuffer.isView(description)
        ? new Uint8Array(
            description.buffer,
            description.byteOffset,
            description.byteLength,
          ).slice()
        : new Uint8Array(description).slice();
      if (
        this.description &&
        (next.length !== this.description.length ||
          next.some((v, i) => v !== this.description![i]))
      )
        throw Error("AVC configuration changed during export.");
      this.description = next;
    }
    this.samples.push(data.slice());
  }
  finalize(): Blob {
    const n = this.samples.length;
    if (!n || !this.description || this.description[0] !== 1)
      throw Error("Missing AVC decoder configuration or samples.");
    const ftyp = box("ftyp", str("isom"), u32(512), str("isomiso2avc1mp41"));
    const payloadSize = this.samples.reduce((v, s) => v + s.length, 0);
    if (payloadSize + ftyp.length + 8 >= 2 ** 32)
      throw Error("Export exceeds 4 GiB; choose a smaller resolution.");
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
      u32(2),
    );
    const tkhd = full(
      "tkhd",
      0,
      7,
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(n),
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
      u32(n),
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
      box("avcC", this.description),
    );
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), avc1),
      full("stts", 0, 0, u32(1), u32(n), u32(1)),
      full("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full(
        "stsz",
        0,
        0,
        u32(0),
        u32(n),
        ...this.samples.map((s) => u32(s.length)),
      ),
      full("stco", 0, 0, u32(1), u32(ftyp.length + 8)),
      full("stss", 0, 0, u32(n), ...this.samples.map((_, i) => u32(i + 1))),
    );
    const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
    const minf = box("minf", full("vmhd", 0, 1, zeros(8)), dinf, stbl);
    const moov = box(
      "moov",
      mvhd,
      box("trak", tkhd, box("mdia", mdhd, hdlr, minf)),
    );
    return new Blob(
      [
        ftyp.buffer,
        concat(u32(payloadSize + 8), str("mdat")).buffer,
        ...this.samples.map((s) => s.buffer as ArrayBuffer),
        moov.buffer,
      ],
      { type: "video/mp4" },
    );
  }
}
