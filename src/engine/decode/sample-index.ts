import type { Mp4Sample } from "./formats/mp4";

/** PTS order is separate from decode order, including reordered B-frames. */
export function createSampleIndex(samples: readonly Mp4Sample[]) {
  const ordered = samples
    .map((sample, index) => ({ time: sample.timestamp, index }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const keys = ordered.filter(({ index }) => samples[index].key);
  if (!keys.length) throw Error("MP4 video track has no decodable keyframe.");
  const prefix = (entries: typeof ordered) => {
    let maximum = -1;
    return entries.map(({ index }) => (maximum = Math.max(maximum, index)));
  };
  const sampleMaximum = prefix(ordered);
  const keyMaximum = prefix(keys);
  const firstKey = keys.reduce(
    (minimum, { index }) => Math.min(minimum, index),
    Infinity,
  );
  const lookup = (entries: typeof ordered, maximum: number[], time: number) => {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (entries[middle].time <= time) low = middle + 1;
      else high = middle;
    }
    return low ? maximum[low - 1] : -1;
  };
  return {
    range(time: number) {
      const key = lookup(keys, keyMaximum, time);
      const start = key < 0 ? firstKey : key;
      return {
        start,
        end: Math.max(start, lookup(ordered, sampleMaximum, time)),
      };
    },
  };
}
