import { validateMp4BoxType } from "../decode/formats/mp4";
import { fetchAssetRange, MAX_RANGE_BYTES } from "./byte-range";
import { fetchAsset } from "./resource";

const MAX_TOP_LEVEL_BOXES = 4096;

/** Read container metadata without downloading mdat; sample offsets stay absolute. */
export async function readMp4Metadata(url: string, signal?: AbortSignal) {
  const first = await fetchAssetRange(url, 0, 512 * 1024, signal);
  const full =
    first.full || first.bytes.byteLength === first.length
      ? first.bytes
      : !first.version
        ? await fetchAsset(url, signal)
        : null;
  const length = full?.byteLength ?? first.length;
  if (length < 8) throw Error("Truncated MP4 box header.");
  let window = first.bytes;
  let windowStart = 0;
  const read = async (start: number, end: number) => {
    if (full) return full.slice(start, end);
    if (end <= first.bytes.byteLength) return first.bytes.slice(start, end);
    if (start >= windowStart && end <= windowStart + window.byteLength)
      return window.slice(start - windowStart, end - windowStart);
    const result = await fetchAssetRange(
      url,
      start,
      Math.min(length, Math.max(end, start + 64 * 1024)),
      signal,
      first.version ?? undefined,
    );
    if (result.length !== length || result.full)
      throw Error("MP4 resource changed or stopped supporting byte ranges.");
    window = result.bytes;
    windowStart = start;
    return window.slice(0, end - start);
  };
  let offset = 0;
  let count = 0;
  let moov: ArrayBuffer | null = null;
  const mdats: { start: number; end: number }[] = [];
  while (offset < length) {
    signal?.throwIfAborted();
    if (++count > MAX_TOP_LEVEL_BOXES || length - offset < 8)
      throw Error("Invalid MP4 top-level box structure.");
    const header = new DataView(
      offset === 0 && !full
        ? first.bytes.slice(0, 8)
        : await read(offset, offset + 8),
    );
    let size = header.getUint32(0);
    const type = String.fromCharCode(...new Uint8Array(header.buffer, 4, 4));
    let headerSize = 8;
    if (size === 1) {
      if (length - offset < 16) throw Error("Truncated MP4 wide box header.");
      const wide = new DataView(
        await read(offset + 8, offset + 16),
      ).getBigUint64(0);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER))
        throw Error("Unsafe MP4 box size.");
      size = Number(wide);
      headerSize = 16;
    } else if (size === 0) size = length - offset;
    if (size < headerSize || size > length - offset)
      throw Error("Invalid MP4 box bounds.");
    validateMp4BoxType(type);
    if (type === "moov") {
      if (moov || size > MAX_RANGE_BYTES)
        throw Error("Duplicate or oversized MP4 metadata.");
      moov = await read(offset, offset + size);
    }
    if (type === "mdat")
      mdats.push({ start: offset + headerSize, end: offset + size });
    offset += size;
  }
  if (!moov || !mdats.length) throw Error("MP4 requires moov and mdat boxes.");
  return {
    moov,
    mdats,
    length,
    full,
    prefix: full ? null : first.bytes,
    version: full ? null : first.version,
  };
}
