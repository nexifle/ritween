/**
 * Defensive reader for progressive, non-fragmented ISO BMFF with local media data,
 * one `avc1`/`avcC` H.264 or `mp4a`/AAC-LC description per track, and at most one
 * video plus one audio track. It supports stts, ctts v0/v1, stsc, stsz, stco/co64,
 * stss, version-0/1 movie/media headers, and rate-1 edit lists containing one media
 * edit with an optional leading empty edit. Decode samples, including preroll before
 * the edit's media time, are preserved and mapped to the movie timeline.
 *
 * Fragments, encryption, external data references, other codecs/sample tables,
 * multiple sample descriptions/media edits, non-identity track matrices, non-square
 * pixel aspect, and clean-aperture sizing are rejected. Input is capped at 512 MiB
 * and one million total samples. Sample offsets refer to the original ArrayBuffer.
 */
import { AAC_CODEC } from "../../codecs/aac";
import { h264CodecString } from "../../codecs/h264";

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Presentation timestamp in seconds, mapped to the movie timeline. */
  timestamp: number;
  duration: number;
  /** Decode timestamp in seconds, mapped to the movie timeline. */
  decodeTimestamp: number;
  /** ISO BMFF sync-sample status (audio samples are sync unless stss says otherwise). */
  key: boolean;
}

export interface Mp4Track {
  id: number;
  kind: "video" | "audio";
  /** WebCodecs-compatible AVC (`avc1.PPCCLL`) or AAC (`mp4a.40.2`) codec string. */
  codec: string;
  /** avcC box payload for AVC, AudioSpecificConfig extracted from esds for AAC. */
  description: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  /** Visible presentation interval in movie seconds; samples outside may be decode preroll. */
  presentationStart: number;
  presentationEnd: number;
  /** Samples are returned in decode order; timestamp is presentation time. */
  samples: Mp4Sample[];
}

export interface Mp4Input {
  /** Movie-header duration in seconds. */
  duration: number;
  tracks: Mp4Track[];
}

const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_SAMPLES = 1_000_000;
const MAX_TABLE_ENTRIES = MAX_SAMPLES;
const MAX_BOXES_PER_PARSE = 100_000;
const MAX_DESCRIPTORS_PER_PARSE = 100_000;
const MAX_AAC_CONFIG_BYTES = 64 * 1024;
const FORBIDDEN_BOXES = new Set([
  "moof",
  "mvex",
  "mfra",
  "traf",
  "tfhd",
  "trun",
  "trex",
  "sinf",
  "schm",
  "schi",
  "tenc",
  "senc",
  "saiz",
  "saio",
  "pssh",
  "encv",
  "enca",
  "uuid",
]);

interface Box {
  type: string;
  start: number;
  payload: number;
  end: number;
}

interface MdatRange {
  start: number;
  end: number;
}

interface ParseBudget {
  boxesRemaining: number;
  descriptorsRemaining: number;
}

interface FullBox {
  version: number;
  flags: number;
}

interface MediaClock {
  timescale: number;
  duration: number;
}

interface EditMapping {
  emptyDuration: number;
  mediaTime: bigint;
  segmentDuration: number;
}

function invalid(message: string): never {
  throw new Error(`Invalid MP4: ${message}`);
}

function safeInteger(value: number, description: string): number {
  if (!Number.isSafeInteger(value))
    invalid(`${description} exceeds safe integer range.`);
  return value;
}

function safeAdd(left: number, right: number, description: string): number {
  return safeInteger(left + right, description);
}

function u64(view: DataView, offset: number, description: string): number {
  const value = view.getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    invalid(`${description} exceeds safe integer range.`);
  return Number(value);
}

function i64(view: DataView, offset: number, description: string): bigint {
  const value = view.getBigInt64(offset);
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  )
    invalid(`${description} exceeds safe integer range.`);
  return value;
}

function typeAt(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function parseBoxes(
  view: DataView,
  start: number,
  end: number,
  budget: ParseBudget,
): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) invalid("truncated box header.");
    const size32 = view.getUint32(offset);
    const type = typeAt(view, offset + 4);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      if (end - offset < 16) invalid(`truncated extended ${type} box header.`);
      size = u64(view, offset + 8, `${type} box size`);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    } else {
      size = size32;
    }
    if (size < headerSize) invalid(`${type} box is smaller than its header.`);
    if (size > end - offset) invalid(`${type} box extends past its parent.`);
    if (FORBIDDEN_BOXES.has(type))
      invalid(`unsupported fragmented or encrypted box ${type}.`);
    if (budget.boxesRemaining <= 0) invalid("box count exceeds parser limit.");
    budget.boxesRemaining--;
    const boxEnd = safeAdd(offset, size, `${type} box end`);
    boxes.push({
      type,
      start: offset,
      payload: offset + headerSize,
      end: boxEnd,
    });
    offset = boxEnd;
  }
  if (offset !== end) invalid("box boundaries do not match their parent.");
  return boxes;
}

function children(view: DataView, box: Box, budget: ParseBudget): Box[] {
  return parseBoxes(view, box.payload, box.end, budget);
}

function one(list: Box[], type: string, required = true): Box | undefined {
  const matches = list.filter((box) => box.type === type);
  if (matches.length > 1) invalid(`duplicate ${type} box.`);
  if (required && matches.length === 0) invalid(`missing ${type} box.`);
  return matches[0];
}

function readFullBox(
  view: DataView,
  box: Box,
  versions: readonly number[],
  allowedFlags = 0,
): FullBox {
  if (box.end - box.payload < 4)
    invalid(`truncated ${box.type} full-box header.`);
  const version = view.getUint8(box.payload);
  const flags =
    (view.getUint8(box.payload + 1) << 16) |
    (view.getUint8(box.payload + 2) << 8) |
    view.getUint8(box.payload + 3);
  if (!versions.includes(version)) invalid(`unsupported ${box.type} version.`);
  if ((flags & ~allowedFlags) !== 0) invalid(`unsupported ${box.type} flags.`);
  return { version, flags };
}

function expectLength(box: Box, expected: number, description: string): void {
  if (box.end - box.payload !== expected)
    invalid(`invalid ${description} length.`);
}

function readMovieClock(view: DataView, box: Box): MediaClock {
  const { version } = readFullBox(view, box, [0, 1]);
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (box.end - box.payload < 20) invalid("truncated mvhd box.");
    timescale = view.getUint32(box.payload + 12);
    duration = view.getUint32(box.payload + 16);
  } else {
    if (box.end - box.payload < 32) invalid("truncated version-1 mvhd box.");
    timescale = view.getUint32(box.payload + 20);
    duration = u64(view, box.payload + 24, "movie duration");
  }
  if (timescale === 0 || duration === 0) invalid("mvhd has an empty clock.");
  return { timescale, duration };
}

interface TrackHeader {
  id: number;
  duration: number;
  width: number;
  height: number;
}

function readTrackHeader(view: DataView, box: Box): TrackHeader {
  const { version } = readFullBox(view, box, [0, 1], 0x7);
  const trackIdOffset = box.payload + (version === 0 ? 12 : 20);
  const matrixOffset = box.payload + (version === 0 ? 40 : 52);
  const minimumLength = version === 0 ? 84 : 96;
  if (box.end - box.payload < minimumLength) invalid("truncated tkhd box.");
  const id = view.getUint32(trackIdOffset);
  if (id === 0) invalid("tkhd has a zero track ID.");
  const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  for (let i = 0; i < identity.length; i++) {
    if (view.getUint32(matrixOffset + i * 4) !== identity[i])
      invalid("non-identity tkhd matrix transforms are unsupported.");
  }
  return {
    id,
    duration:
      version === 0
        ? view.getUint32(box.payload + 20)
        : u64(view, box.payload + 28, "track duration"),
    width: view.getUint32(matrixOffset + 36),
    height: view.getUint32(matrixOffset + 40),
  };
}

function readMediaClock(view: DataView, box: Box): MediaClock {
  const { version } = readFullBox(view, box, [0, 1]);
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (box.end - box.payload < 20) invalid("truncated mdhd box.");
    timescale = view.getUint32(box.payload + 12);
    duration = view.getUint32(box.payload + 16);
  } else {
    if (box.end - box.payload < 32) invalid("truncated version-1 mdhd box.");
    timescale = view.getUint32(box.payload + 20);
    duration = u64(view, box.payload + 24, "media duration");
  }
  if (timescale === 0 || duration === 0) invalid("mdhd has an empty clock.");
  return { timescale, duration };
}

function readHandler(view: DataView, box: Box): string {
  readFullBox(view, box, [0]);
  if (box.end - box.payload < 12) invalid("truncated hdlr box.");
  return typeAt(view, box.payload + 8);
}

function readTableCount(
  view: DataView,
  box: Box,
  stride: number,
  versions: readonly number[] = [0],
): number {
  readFullBox(view, box, versions);
  if (box.end - box.payload < 8) invalid(`truncated ${box.type} table.`);
  const count = view.getUint32(box.payload + 4);
  if (count > MAX_TABLE_ENTRIES)
    invalid(`${box.type} entry count is too large.`);
  const requiredBytes = 8 + count * stride;
  if (
    !Number.isSafeInteger(requiredBytes) ||
    box.end - box.payload !== requiredBytes
  )
    invalid(`invalid ${box.type} table length.`);
  return count;
}

interface TimeRun {
  count: number;
  value: number;
}

function readTimeRuns(view: DataView, box: Box, signed: boolean): TimeRun[] {
  const count = readTableCount(
    view,
    box,
    8,
    box.type === "ctts" ? [0, 1] : [0],
  );
  const runs: TimeRun[] = [];
  let total = 0;
  let offset = box.payload + 8;
  for (let i = 0; i < count; i++) {
    const sampleCount = view.getUint32(offset);
    const value = signed
      ? view.getInt32(offset + 4)
      : view.getUint32(offset + 4);
    if (sampleCount === 0) invalid(`${box.type} contains an empty run.`);
    total = safeAdd(total, sampleCount, `${box.type} sample count`);
    if (total > MAX_SAMPLES) invalid(`${box.type} sample count is too large.`);
    if (box.type === "stts" && value === 0)
      invalid("stts contains a zero sample duration.");
    runs.push({ count: sampleCount, value });
    offset += 8;
  }
  return runs;
}

function expandTimeRuns(
  runs: TimeRun[],
  sampleCount: number,
  description: string,
  defaultValue: number,
): number[] {
  const values = new Array<number>(sampleCount);
  let sample = 0;
  for (const run of runs) {
    if (run.count > sampleCount - sample)
      invalid(`${description} has more entries than stsz.`);
    for (let i = 0; i < run.count; i++) values[sample++] = run.value;
  }
  if (runs.length === 0 && defaultValue !== undefined)
    values.fill(defaultValue);
  else if (sample !== sampleCount)
    invalid(`${description} count does not match stsz.`);
  return values;
}

function readSampleSizes(view: DataView, box: Box, budget: number): number[] {
  readFullBox(view, box, [0]);
  if (box.end - box.payload < 12) invalid("truncated stsz box.");
  const fixedSize = view.getUint32(box.payload + 4);
  const count = view.getUint32(box.payload + 8);
  if (count === 0) invalid("stsz contains no samples.");
  if (count > budget || count > MAX_SAMPLES)
    invalid("sample count exceeds parser limit.");
  const expected = fixedSize === 0 ? 12 + count * 4 : 12;
  if (!Number.isSafeInteger(expected) || box.end - box.payload !== expected)
    invalid("invalid stsz table length.");
  const sizes = new Array<number>(count);
  if (fixedSize !== 0) {
    sizes.fill(fixedSize);
  } else {
    let offset = box.payload + 12;
    for (let i = 0; i < count; i++, offset += 4) {
      const size = view.getUint32(offset);
      if (size === 0) invalid("stsz contains an empty sample.");
      sizes[i] = size;
    }
  }
  return sizes;
}

interface ChunkRun {
  firstChunk: number;
  samplesPerChunk: number;
  descriptionIndex: number;
}

function readChunkRuns(view: DataView, box: Box): ChunkRun[] {
  const count = readTableCount(view, box, 12);
  if (count === 0) invalid("stsc contains no entries.");
  const runs: ChunkRun[] = [];
  let offset = box.payload + 8;
  for (let i = 0; i < count; i++) {
    const run = {
      firstChunk: view.getUint32(offset),
      samplesPerChunk: view.getUint32(offset + 4),
      descriptionIndex: view.getUint32(offset + 8),
    };
    if (
      run.firstChunk === 0 ||
      run.samplesPerChunk === 0 ||
      run.descriptionIndex !== 1 ||
      (i === 0 && run.firstChunk !== 1) ||
      (i > 0 && run.firstChunk <= runs[i - 1].firstChunk)
    )
      invalid("invalid stsc run ordering or sample description index.");
    runs.push(run);
    offset += 12;
  }
  return runs;
}

function readChunkOffsets(view: DataView, box: Box): number[] {
  const stride = box.type === "co64" ? 8 : 4;
  const count = readTableCount(view, box, stride);
  if (count === 0 || count > MAX_SAMPLES)
    invalid(`${box.type} contains an invalid chunk count.`);
  const offsets = new Array<number>(count);
  let offset = box.payload + 8;
  for (let i = 0; i < count; i++) {
    offsets[i] =
      stride === 8
        ? u64(view, offset, `${box.type} chunk offset`)
        : view.getUint32(offset);
    offset += stride;
  }
  return offsets;
}

function readSyncSamples(
  view: DataView,
  box: Box | undefined,
  sampleCount: number,
): boolean[] {
  const sync = new Array<boolean>(sampleCount).fill(box === undefined);
  if (!box) return sync;
  const count = readTableCount(view, box, 4);
  let previous = 0;
  let offset = box.payload + 8;
  for (let i = 0; i < count; i++, offset += 4) {
    const sampleNumber = view.getUint32(offset);
    if (
      sampleNumber === 0 ||
      sampleNumber > sampleCount ||
      sampleNumber <= previous
    )
      invalid("stss sample numbers must be sorted and within stsz.");
    sync[sampleNumber - 1] = true;
    previous = sampleNumber;
  }
  return sync;
}

function readDescriptionBytes(view: DataView, box: Box): Uint8Array {
  return new Uint8Array(
    view.buffer,
    box.payload,
    box.end - box.payload,
  ).slice();
}

function validateAvcConfiguration(view: DataView, box: Box): void {
  const length = box.end - box.payload;
  if (length < 7) invalid("avcC configuration is truncated.");
  if (view.getUint8(box.payload) !== 1)
    invalid("unsupported avcC configuration version.");
  const lengthSize = view.getUint8(box.payload + 4);
  if ((lengthSize & 0xfc) !== 0xfc || (lengthSize & 0x03) === 2)
    invalid("invalid avcC NAL length-size field.");
  const spsField = view.getUint8(box.payload + 5);
  if ((spsField & 0xe0) !== 0xe0) invalid("invalid avcC SPS reserved bits.");
  let offset = box.payload + 6;
  const readParameterSets = (count: number, expectedType: number) => {
    for (let i = 0; i < count; i++) {
      if (box.end - offset < 2) invalid("truncated avcC parameter-set length.");
      const size = view.getUint16(offset);
      offset += 2;
      if (size === 0 || size > box.end - offset)
        invalid("avcC parameter set exceeds configuration bounds.");
      if ((view.getUint8(offset) & 0x1f) !== expectedType)
        invalid("avcC contains an unexpected NAL parameter-set type.");
      offset += size;
    }
  };
  const spsCount = spsField & 0x1f;
  if (spsCount === 0) invalid("avcC contains no sequence parameter sets.");
  readParameterSets(spsCount, 7);
  if (offset >= box.end) invalid("avcC is missing its PPS count.");
  const ppsCount = view.getUint8(offset++);
  if (ppsCount === 0) invalid("avcC contains no picture parameter sets.");
  readParameterSets(ppsCount, 8);

  if (offset < box.end) {
    const highProfiles = new Set([
      44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144,
    ]);
    if (
      !highProfiles.has(view.getUint8(box.payload + 1)) ||
      box.end - offset < 4
    )
      invalid("unexpected trailing avcC configuration bytes.");
    if (
      (view.getUint8(offset) & 0xfc) !== 0xfc ||
      (view.getUint8(offset + 1) & 0xf8) !== 0xf8 ||
      (view.getUint8(offset + 2) & 0xf8) !== 0xf8
    )
      invalid("invalid avcC extension reserved bits.");
    const extensionCount = view.getUint8(offset + 3);
    offset += 4;
    readParameterSets(extensionCount, 13);
  }
  if (offset !== box.end)
    invalid("avcC has trailing or malformed configuration data.");
}

function parseAvcDescription(
  view: DataView,
  sampleEntry: Box,
  budget: ParseBudget,
): {
  description: Uint8Array;
  codec: string;
  width: number;
  height: number;
} {
  if (sampleEntry.type !== "avc1")
    invalid(`unsupported video sample entry ${sampleEntry.type}.`);
  if (sampleEntry.end - sampleEntry.start < 86)
    invalid("truncated avc1 sample entry.");
  const width = view.getUint16(sampleEntry.start + 32);
  const height = view.getUint16(sampleEntry.start + 34);
  if (width === 0 || height === 0) invalid("avc1 has zero dimensions.");
  const configBoxes = parseBoxes(
    view,
    sampleEntry.start + 86,
    sampleEntry.end,
    budget,
  );
  const pasp = one(configBoxes, "pasp", false);
  if (pasp) {
    expectLength(pasp, 8, "pasp");
    const horizontalSpacing = view.getUint32(pasp.payload);
    const verticalSpacing = view.getUint32(pasp.payload + 4);
    if (
      horizontalSpacing === 0 ||
      verticalSpacing === 0 ||
      horizontalSpacing !== verticalSpacing
    )
      invalid("non-square pasp sample aspect ratios are unsupported.");
  }
  if (one(configBoxes, "clap", false))
    invalid("clean-aperture display sizing is unsupported.");
  const avcC = one(configBoxes, "avcC");
  if (!avcC) invalid("avc1 is missing avcC configuration.");
  validateAvcConfiguration(view, avcC);
  const description = readDescriptionBytes(view, avcC);
  const codec = h264CodecString(description);
  return { description, codec, width, height };
}

interface Descriptor {
  tag: number;
  start: number;
  end: number;
}

function readDescriptors(
  view: DataView,
  start: number,
  end: number,
  budget: ParseBudget,
): Descriptor[] {
  const descriptors: Descriptor[] = [];
  let offset = start;
  while (offset < end) {
    if (budget.descriptorsRemaining <= 0)
      invalid("MPEG-4 descriptor count exceeds parser limit.");
    budget.descriptorsRemaining--;
    if (end - offset < 2) invalid("truncated MPEG-4 descriptor.");
    const tag = view.getUint8(offset++);
    let length = 0;
    let terminated = false;
    for (let i = 0; i < 4; i++) {
      if (offset >= end) invalid("truncated MPEG-4 descriptor length.");
      const byte = view.getUint8(offset++);
      length = length * 128 + (byte & 0x7f);
      if (!Number.isSafeInteger(length))
        invalid("descriptor length is too large.");
      if ((byte & 0x80) === 0) {
        terminated = true;
        break;
      }
    }
    if (!terminated) invalid("MPEG-4 descriptor length exceeds four bytes.");
    if (length > end - offset) invalid("descriptor extends past esds.");
    const descriptorEnd = offset + length;
    descriptors.push({ tag, start: offset, end: descriptorEnd });
    offset = descriptorEnd;
  }
  return descriptors;
}

function readAudioSpecificConfig(
  view: DataView,
  start: number,
  end: number,
): { description: Uint8Array; channels: number; sampleRate: number } {
  if (end - start < 2) invalid("AAC AudioSpecificConfig is truncated.");
  if (end - start > MAX_AAC_CONFIG_BYTES)
    invalid("AAC AudioSpecificConfig exceeds parser limit.");
  const bitLength = (end - start) * 8;
  let bit = 0;
  const readBits = (count: number): number => {
    if (count > 24 || bit + count > bitLength)
      invalid("AAC AudioSpecificConfig is truncated.");
    let value = 0;
    for (let i = 0; i < count; i++, bit++) {
      const byte = view.getUint8(start + (bit >> 3));
      value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  let objectType = readBits(5);
  if (objectType === 31) objectType = 32 + readBits(6);
  if (objectType !== 2)
    invalid("only AAC-LC AudioSpecificConfig is supported.");
  const frequencyIndex = readBits(4);
  const frequencies = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ];
  let sampleRate: number;
  if (frequencyIndex === 15) {
    sampleRate = readBits(24);
  } else {
    sampleRate = frequencies[frequencyIndex] ?? 0;
  }
  const channelConfig = readBits(4);
  const channels = [0, 1, 2, 3, 4, 5, 6, 8][channelConfig] ?? 0;
  if (sampleRate === 0 || channels === 0)
    invalid("unsupported AAC sampling frequency or channel configuration.");
  return {
    description: new Uint8Array(view.buffer, start, end - start).slice(),
    channels,
    sampleRate,
  };
}

function parseAacDescription(
  view: DataView,
  sampleEntry: Box,
  budget: ParseBudget,
): {
  description: Uint8Array;
  codec: string;
  channels: number;
  sampleRate: number;
} {
  if (sampleEntry.type !== "mp4a")
    invalid(`unsupported audio sample entry ${sampleEntry.type}.`);
  if (sampleEntry.end - sampleEntry.start < 36)
    invalid("truncated mp4a sample entry.");
  const sampleEntryVersion = view.getUint16(sampleEntry.start + 16);
  if (sampleEntryVersion !== 0)
    invalid("unsupported versioned mp4a sample entry.");
  const channels = view.getUint16(sampleEntry.start + 24);
  const sampleRateFixed = view.getUint32(sampleEntry.start + 32);
  const sampleRate = sampleRateFixed >>> 16;
  if (channels === 0 || sampleRate === 0 || (sampleRateFixed & 0xffff) !== 0)
    invalid("invalid mp4a channel count or sample rate.");
  const childBoxes = parseBoxes(
    view,
    sampleEntry.start + 36,
    sampleEntry.end,
    budget,
  );
  const esds = one(childBoxes, "esds");
  if (!esds) invalid("mp4a is missing esds.");
  readFullBox(view, esds, [0]);
  const root = readDescriptors(view, esds.payload + 4, esds.end, budget);
  const esDescriptors = root.filter((descriptor) => descriptor.tag === 0x03);
  if (esDescriptors.length !== 1)
    invalid("esds must contain one ES_Descriptor.");
  const es = esDescriptors[0];
  if (es.end - es.start < 3) invalid("truncated ES_Descriptor.");
  const esFlags = view.getUint8(es.start + 2);
  let nestedStart = es.start + 3;
  if (esFlags & 0x80) nestedStart += 2;
  if (esFlags & 0x40) {
    if (nestedStart >= es.end) invalid("truncated ES_Descriptor URL.");
    nestedStart += 1 + view.getUint8(nestedStart);
  }
  if (esFlags & 0x20) nestedStart += 2;
  if (nestedStart > es.end)
    invalid("ES_Descriptor flags exceed descriptor bounds.");
  const esChildren = readDescriptors(view, nestedStart, es.end, budget);
  const decoderConfigs = esChildren.filter(
    (descriptor) => descriptor.tag === 0x04,
  );
  if (decoderConfigs.length !== 1)
    invalid("esds must contain one DecoderConfigDescriptor.");
  const decoderConfig = decoderConfigs[0];
  if (decoderConfig.end - decoderConfig.start < 13)
    invalid("truncated DecoderConfigDescriptor.");
  if (view.getUint8(decoderConfig.start) !== 0x40)
    invalid("unsupported esds objectTypeIndication.");
  if (view.getUint8(decoderConfig.start + 1) >> 2 !== 5)
    invalid("esds does not describe an AAC audio stream.");
  const configChildren = readDescriptors(
    view,
    decoderConfig.start + 13,
    decoderConfig.end,
    budget,
  );
  const specificConfigs = configChildren.filter(
    (descriptor) => descriptor.tag === 0x05,
  );
  if (specificConfigs.length !== 1)
    invalid("esds must contain one DecoderSpecificInfo descriptor.");
  const asc = specificConfigs[0];
  const parsed = readAudioSpecificConfig(view, asc.start, asc.end);
  if (parsed.channels !== channels || parsed.sampleRate !== sampleRate)
    invalid("AAC configuration does not match mp4a sample entry.");
  return { ...parsed, codec: AAC_CODEC };
}

function readEditMapping(
  view: DataView,
  edts: Box | undefined,
  movieTimescale: number,
  budget: ParseBudget,
): EditMapping | undefined {
  if (!edts) return undefined;
  const list = children(view, edts, budget);
  const elst = one(list, "elst");
  if (!elst) invalid("edts is missing elst.");
  const { version } = readFullBox(view, elst, [0, 1]);
  if (elst.end - elst.payload < 8) invalid("truncated elst box.");
  const count = view.getUint32(elst.payload + 4);
  if (count === 0 || count > 2)
    invalid("only a media edit with optional leading empty edit is supported.");
  const stride = version === 0 ? 12 : 20;
  if (elst.end - elst.payload !== 8 + count * stride)
    invalid("invalid elst table length.");
  const edits: { duration: number; mediaTime: bigint; rate: number }[] = [];
  let offset = elst.payload + 8;
  for (let i = 0; i < count; i++) {
    const duration =
      version === 0
        ? view.getUint32(offset)
        : u64(view, offset, "edit segment duration");
    const mediaTime =
      version === 0
        ? BigInt(view.getInt32(offset + 4))
        : i64(view, offset + 8, "edit media time");
    const rateOffset = offset + (version === 0 ? 8 : 16);
    const rate =
      view.getInt16(rateOffset) * 65536 + view.getUint16(rateOffset + 2);
    if (duration === 0 || rate !== 65536)
      invalid("only positive-duration edits at rate 1 are supported.");
    edits.push({ duration, mediaTime, rate });
    offset += stride;
  }
  let emptyDuration = 0;
  let mediaEdit: (typeof edits)[number] | undefined;
  if (edits.length === 2) {
    if (edits[0].mediaTime !== -1n)
      invalid("the first edit must be an empty edit.");
    emptyDuration = edits[0].duration;
    mediaEdit = edits[1];
  } else {
    mediaEdit = edits[0];
  }
  if (!mediaEdit || mediaEdit.mediaTime < 0n)
    invalid("elst must contain a media edit after any empty edit.");
  safeInteger(movieTimescale, "movie timescale");
  return {
    emptyDuration,
    mediaTime: mediaEdit.mediaTime,
    segmentDuration: mediaEdit.duration,
  };
}

function isInsideMdat(
  ranges: MdatRange[],
  offset: number,
  size: number,
): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (offset < range.start) {
      high = middle - 1;
    } else if (offset >= range.end) {
      low = middle + 1;
    } else {
      return size <= range.end - offset;
    }
  }
  return false;
}

function validateLocalDataReference(
  view: DataView,
  minfBoxes: Box[],
  sampleEntry: Box,
  budget: ParseBudget,
): void {
  if (sampleEntry.end - sampleEntry.start < 16)
    invalid("truncated media sample entry.");
  if (view.getUint16(sampleEntry.start + 14) !== 1)
    invalid("external media data references are unsupported.");
  const dinf = one(minfBoxes, "dinf");
  const dref = one(children(view, dinf!, budget), "dref");
  readFullBox(view, dref!, [0], 1);
  if (dref!.end - dref!.payload < 8 || view.getUint32(dref!.payload + 4) !== 1)
    invalid("exactly one local data reference is supported.");
  const references = parseBoxes(view, dref!.payload + 8, dref!.end, budget);
  if (references.length !== 1 || references[0].type !== "url ")
    invalid("unsupported external media data reference.");
  const localUrl = readFullBox(view, references[0], [0], 1);
  if (localUrl.flags !== 1 || references[0].end - references[0].payload !== 4)
    invalid("media URL data reference is not self-contained.");
}

function parseTrack(
  view: DataView,
  trak: Box,
  mdats: MdatRange[],
  movieTimescale: number,
  movieDuration: number,
  budget: ParseBudget,
  sampleBudget: number,
): { track: Mp4Track; sampleCount: number } {
  const trakBoxes = children(view, trak, budget);
  const tkhd = one(trakBoxes, "tkhd");
  const trackHeader = readTrackHeader(view, tkhd!);
  if (trackHeader.duration === 0 || trackHeader.duration > movieDuration)
    invalid("tkhd duration is empty or exceeds mvhd duration.");
  const edts = one(trakBoxes, "edts", false);
  const mdia = one(trakBoxes, "mdia");
  const mdiaBoxes = children(view, mdia!, budget);
  const mdhd = one(mdiaBoxes, "mdhd");
  const mediaClock = readMediaClock(view, mdhd!);
  const hdlr = one(mdiaBoxes, "hdlr");
  const handler = readHandler(view, hdlr!);
  if (handler !== "vide" && handler !== "soun")
    invalid(`unsupported track handler ${handler}.`);
  const minf = one(mdiaBoxes, "minf");
  const minfBoxes = children(view, minf!, budget);
  const mediaHeaderType = handler === "vide" ? "vmhd" : "smhd";
  const mediaHeader = one(minfBoxes, mediaHeaderType);
  if (handler === "vide") {
    const header = readFullBox(view, mediaHeader!, [0], 1);
    if (header.flags !== 1 || mediaHeader!.end - mediaHeader!.payload !== 12)
      invalid("invalid vmhd box.");
  } else {
    readFullBox(view, mediaHeader!, [0]);
    if (mediaHeader!.end - mediaHeader!.payload !== 8)
      invalid("invalid smhd box.");
  }
  if (one(minfBoxes, handler === "vide" ? "smhd" : "vmhd", false))
    invalid("media header does not match hdlr.");
  const stbl = one(minfBoxes, "stbl");
  const stblBoxes = children(view, stbl!, budget);
  const supportedSampleTables = new Set([
    "stsd",
    "stts",
    "ctts",
    "stsc",
    "stsz",
    "stco",
    "co64",
    "stss",
  ]);
  if (stblBoxes.some((table) => !supportedSampleTables.has(table.type)))
    invalid("unsupported sample table box.");
  const stsd = one(stblBoxes, "stsd");
  readFullBox(view, stsd!, [0]);
  if (stsd!.end - stsd!.payload < 8) invalid("truncated stsd box.");
  const descriptionCount = view.getUint32(stsd!.payload + 4);
  if (descriptionCount !== 1)
    invalid("exactly one sample description is supported.");
  const descriptions = parseBoxes(view, stsd!.payload + 8, stsd!.end, budget);
  if (descriptions.length !== 1)
    invalid("stsd entry count does not match its contents.");
  const sampleEntry = descriptions[0];
  validateLocalDataReference(view, minfBoxes, sampleEntry, budget);
  const mediaDescription =
    handler === "vide"
      ? parseAvcDescription(view, sampleEntry, budget)
      : parseAacDescription(view, sampleEntry, budget);
  if (handler === "vide" && "width" in mediaDescription) {
    if (
      trackHeader.width !== mediaDescription.width * 65536 ||
      trackHeader.height !== mediaDescription.height * 65536
    )
      invalid("tkhd display dimensions differing from avc1 are unsupported.");
  } else if (trackHeader.width !== 0 || trackHeader.height !== 0) {
    invalid("non-zero audio tkhd display dimensions are unsupported.");
  }

  const sizes = readSampleSizes(view, one(stblBoxes, "stsz")!, sampleBudget);
  const sampleCount = sizes.length;
  const stts = readTimeRuns(view, one(stblBoxes, "stts")!, false);
  const durations = expandTimeRuns(stts, sampleCount, "stts", 0);
  const cttsBox = one(stblBoxes, "ctts", false);
  const compositionOffsets = cttsBox
    ? expandTimeRuns(
        readTimeRuns(
          view,
          cttsBox,
          readFullBox(view, cttsBox, [0, 1]).version === 1,
        ),
        sampleCount,
        "ctts",
        0,
      )
    : new Array<number>(sampleCount).fill(0);
  const syncSamples = readSyncSamples(
    view,
    one(stblBoxes, "stss", false),
    sampleCount,
  );
  const stco = one(stblBoxes, "stco", false);
  const co64 = one(stblBoxes, "co64", false);
  if (Boolean(stco) === Boolean(co64))
    invalid("exactly one stco or co64 table is required.");
  const chunkOffsets = readChunkOffsets(view, (stco ?? co64)!);
  const chunkRuns = readChunkRuns(view, one(stblBoxes, "stsc")!);
  if (chunkRuns[chunkRuns.length - 1].firstChunk > chunkOffsets.length)
    invalid("stsc references a chunk beyond stco/co64.");

  const sampleOffsets = new Array<number>(sampleCount);
  let sampleIndex = 0;
  let runIndex = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length; chunk++) {
    while (
      runIndex + 1 < chunkRuns.length &&
      chunkRuns[runIndex + 1].firstChunk <= chunk
    )
      runIndex++;
    const run = chunkRuns[runIndex];
    if (run.firstChunk > chunk) invalid("stsc does not cover every chunk.");
    let offset = chunkOffsets[chunk - 1];
    if (run.samplesPerChunk > sampleCount - sampleIndex)
      invalid("stsc maps more samples than stsz contains.");
    for (let i = 0; i < run.samplesPerChunk; i++) {
      const size = sizes[sampleIndex];
      if (!isInsideMdat(mdats, offset, size))
        invalid("sample range is outside every mdat payload.");
      sampleOffsets[sampleIndex] = offset;
      offset = safeAdd(offset, size, "sample range end");
      sampleIndex++;
    }
  }
  if (sampleIndex !== sampleCount)
    invalid("stsc chunk mapping does not match stsz sample count.");

  const mapping = readEditMapping(view, edts, movieTimescale, budget);
  const samples: Mp4Sample[] = [];
  let decodeTicks = 0;
  for (let i = 0; i < sampleCount; i++) {
    const decodeTime = decodeTicks;
    const sampleDuration = durations[i];
    decodeTicks = safeAdd(decodeTicks, sampleDuration, "decode timeline");
    if (decodeTicks > mediaClock.duration)
      invalid("stts timeline exceeds mdhd duration.");
    const presentationTime = safeAdd(
      decodeTime,
      compositionOffsets[i],
      "presentation timestamp",
    );
    const mediaStart = mapping ? Number(mapping.mediaTime) : 0;
    const emptySeconds = mapping ? mapping.emptyDuration / movieTimescale : 0;
    let timestamp =
      emptySeconds + (presentationTime - mediaStart) / mediaClock.timescale;
    const duration = sampleDuration / mediaClock.timescale;
    const decodeTimestamp =
      emptySeconds + (decodeTime - mediaStart) / mediaClock.timescale;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(decodeTimestamp) ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      invalid("sample timestamp or duration is invalid.");
    // Avoid exposing negative zero from a timestamp exactly at the edit origin.
    if (Object.is(timestamp, -0)) timestamp = 0;
    samples.push({
      offset: sampleOffsets[i],
      size: sizes[i],
      timestamp,
      duration,
      decodeTimestamp,
      key: syncSamples[i],
    });
  }

  return {
    track: {
      id: trackHeader.id,
      kind: handler === "vide" ? "video" : "audio",
      ...mediaDescription,
      presentationStart: mapping ? mapping.emptyDuration / movieTimescale : 0,
      presentationEnd: mapping
        ? safeAdd(
            mapping.emptyDuration,
            mapping.segmentDuration,
            "edit-list duration",
          ) / movieTimescale
        : trackHeader.duration / movieTimescale,
      samples,
    },
    sampleCount,
  };
}

/** Parse a non-fragmented H.264/AAC MP4 without browser or third-party APIs. */
export function parseMp4(bytes: ArrayBuffer): Mp4Input {
  if (!(bytes instanceof ArrayBuffer)) invalid("input must be an ArrayBuffer.");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES)
    invalid("input byte length is empty or exceeds parser limit.");
  const view = new DataView(bytes);
  const budget: ParseBudget = {
    boxesRemaining: MAX_BOXES_PER_PARSE,
    descriptorsRemaining: MAX_DESCRIPTORS_PER_PARSE,
  };
  const topLevel = parseBoxes(view, 0, bytes.byteLength, budget);
  const moov = one(topLevel, "moov");
  const moovBoxes = children(view, moov!, budget);
  const mvhd = one(moovBoxes, "mvhd");
  const movieClock = readMovieClock(view, mvhd!);
  const mdatBoxes = topLevel.filter((box) => box.type === "mdat");
  if (mdatBoxes.length === 0) invalid("missing mdat box.");
  const mdats = mdatBoxes
    .map((box) => ({ start: box.payload, end: box.end }))
    .sort((left, right) => left.start - right.start);
  const traks = moovBoxes.filter((box) => box.type === "trak");
  if (traks.length === 0) invalid("moov contains no media tracks.");
  if (traks.length > 2) invalid("at most two media tracks are supported.");
  const tracks: Mp4Track[] = [];
  const ids = new Set<number>();
  let totalSamples = 0;
  for (const trak of traks) {
    const parsed = parseTrack(
      view,
      trak,
      mdats,
      movieClock.timescale,
      movieClock.duration,
      budget,
      MAX_SAMPLES - totalSamples,
    );
    if (ids.has(parsed.track.id)) invalid("duplicate track ID.");
    ids.add(parsed.track.id);
    totalSamples = safeAdd(
      totalSamples,
      parsed.sampleCount,
      "total sample count",
    );
    if (totalSamples > MAX_SAMPLES)
      invalid("total sample count exceeds parser limit.");
    tracks.push(parsed.track);
  }
  const duration = movieClock.duration / movieClock.timescale;
  if (!Number.isFinite(duration) || duration <= 0)
    invalid("movie duration is invalid.");
  return { duration, tracks };
}
