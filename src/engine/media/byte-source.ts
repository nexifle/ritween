import { parseMp4Metadata, type Mp4Input } from "../decode/formats/mp4";
import { fetchAssetRange, MAX_RANGE_BYTES } from "./byte-range";
import { readMp4Metadata } from "./mp4-metadata";
import { MAX_ASSET_BYTES, resolveAssetUrl } from "./resource";

const BLOCK_BYTES = 256 * 1024;
const CACHE_BYTES = 8 * 2 ** 20;

const cachedBlocks = new Map<ArrayBuffer, () => void>();
let cachedBytes = 0;
let fullBytes = 0;

/** Read copies keep consumer ownership separate from the cache. */
async function createByteSource(url: string, signal?: AbortSignal) {
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  let metadata;
  try {
    metadata = await readMp4Metadata(url, abort.signal);
  } catch (error) {
    signal?.removeEventListener("abort", forwardAbort);
    throw error;
  }
  let full = metadata.full;
  if (full && fullBytes + full.byteLength > MAX_ASSET_BYTES) {
    signal?.removeEventListener("abort", forwardAbort);
    throw Error("Shared full asset budget exceeded.");
  }
  fullBytes += full?.byteLength ?? 0;
  // Do not expose a second reference that would defeat disposal of the payload.
  const info = {
    moov: metadata.moov,
    mdats: metadata.mdats,
    length: metadata.length,
    version: metadata.version,
  };
  metadata.full = null;
  const cache = new Map<number, ArrayBuffer>();
  let retained = 0;
  const remember = (start: number, block: ArrayBuffer) => {
    if (!cache.has(start)) {
      while (cachedBytes + block.byteLength > CACHE_BYTES) {
        const [oldest, evict] = cachedBlocks.entries().next().value!;
        cachedBlocks.delete(oldest);
        cachedBytes -= oldest.byteLength;
        evict();
      }
      retained += block.byteLength;
      cachedBytes += block.byteLength;
      cache.set(start, block);
    }
    cachedBlocks.delete(block);
    cachedBlocks.set(block, () => {
      cache.delete(start);
      retained -= block.byteLength;
    });
  };
  if (metadata.prefix) {
    for (
      let start = 0;
      start < metadata.prefix.byteLength;
      start += BLOCK_BYTES
    )
      remember(start, metadata.prefix.slice(start, start + BLOCK_BYTES));
    metadata.prefix = null;
  }
  let disposed = false;
  let parsed: Mp4Input | null = null;
  // Serialize requests to keep in-flight byte allocation bounded as well as cache size.
  let pending: Promise<unknown> = Promise.resolve();
  const read = async (start: number, end: number, readSignal: AbortSignal) => {
    readSignal.throwIfAborted();
    if (disposed) throw Error("Byte source is disposed.");
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > info.length ||
      end - start > MAX_RANGE_BYTES
    )
      throw Error("Invalid byte source range.");
    if (full) return new Uint8Array(full.slice(start, end));
    const output = new Uint8Array(end - start);
    for (let at = start; at < end;) {
      readSignal.throwIfAborted();
      const blockStart = Math.floor(at / BLOCK_BYTES) * BLOCK_BYTES;
      const blockEnd = Math.min(blockStart + BLOCK_BYTES, info.length);
      let bytes = cache.get(blockStart);
      if (!bytes) {
        const result = await fetchAssetRange(
          url,
          blockStart,
          blockEnd,
          readSignal,
          info.version!,
        );
        readSignal.throwIfAborted();
        if (result.length !== info.length || result.full)
          throw Error("Byte source resource changed.");
        bytes = result.bytes;
      }
      remember(blockStart, bytes);
      const stop = Math.min(end, blockEnd);
      output.set(new Uint8Array(bytes, at - blockStart, stop - at), at - start);
      at = stop;
    }
    return output;
  };
  return {
    ...info,
    parse(): Mp4Input {
      if (disposed) throw Error("Byte source is disposed.");
      parsed ??= parseMp4Metadata(info.moov, info.mdats, info.length);
      return {
        duration: parsed.duration,
        tracks: parsed.tracks.map((track) => ({ ...track })),
      };
    },
    get usage() {
      return { cacheBytes: retained, fullBytes: full?.byteLength ?? 0 };
    },
    read(start: number, end: number, signal?: AbortSignal) {
      const controller = new AbortController();
      const sources = [abort.signal, signal].filter(
        (item): item is AbortSignal => !!item,
      );
      const listeners = sources.map((source) => {
        const forward = () => controller.abort(source.reason);
        if (source.aborted) forward();
        else source.addEventListener("abort", forward, { once: true });
        return () => source.removeEventListener("abort", forward);
      });
      const result = pending
        .then(() => read(start, end, controller.signal))
        .finally(() => {
          for (const remove of listeners) remove();
        });
      pending = result.catch(() => {});
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort(Error("Byte source is disposed."));
      signal?.removeEventListener("abort", forwardAbort);
      fullBytes -= full?.byteLength ?? 0;
      full = null;
      parsed = null;
      for (const block of cache.values()) {
        cachedBlocks.delete(block);
        cachedBytes -= block.byteLength;
      }
      cache.clear();
      retained = 0;
    },
  };
}

type ByteSource = Awaited<ReturnType<typeof createByteSource>>;
type SharedRead = {
  controller: AbortController;
  promise: Promise<Uint8Array>;
  consumers: number;
};
type SharedSource = {
  controller: AbortController;
  promise: Promise<ByteSource>;
  owners: number;
  source?: ByteSource;
  reads: Map<string, SharedRead>;
};
const sources = new Map<string, SharedSource>();

/** Internal accounting retains no additional payload references. */
export function byteSourceUsage() {
  return { sources: sources.size, cacheBytes: cachedBytes, fullBytes };
}

function consume<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal!.reason);
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

/** Release the resource cache when its last owner disposes. */
export async function openByteSource(url: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const resolved = resolveAssetUrl(url);
  resolved.hash = "";
  const key = resolved.href;
  let shared = sources.get(key);
  if (!shared) {
    if (sources.size >= 16)
      throw Error("Shared byte source owner limit exceeded.");
    const controller = new AbortController();
    shared = {
      controller,
      promise: createByteSource(key, controller.signal),
      owners: 0,
      reads: new Map(),
    };
    sources.set(key, shared);
  }
  const entry = shared;
  entry.owners++;
  let released = false;
  const owner = new AbortController();
  const release = () => {
    if (released) return;
    released = true;
    owner.abort(
      signal?.aborted ? signal.reason : Error("Byte source is disposed."),
    );
    signal?.removeEventListener("abort", release);
    if (--entry.owners === 0) {
      if (sources.get(key) === entry) sources.delete(key);
      entry.controller.abort(Error("Byte source is disposed."));
      if (entry.source) entry.source.dispose();
      else
        void entry.promise.then(
          (source) => source.dispose(),
          () => {},
        );
    }
  };
  signal?.addEventListener("abort", release, { once: true });
  let source: ByteSource;
  try {
    source = await consume(entry.promise, owner.signal);
    owner.signal.throwIfAborted();
    entry.source = source;
  } catch (error) {
    release();
    throw error;
  }
  return {
    moov: source.moov,
    mdats: source.mdats,
    length: source.length,
    version: source.version,
    parse() {
      owner.signal.throwIfAborted();
      return source.parse();
    },
    get usage() {
      return released ? { cacheBytes: 0, fullBytes: 0 } : source.usage;
    },
    async read(start: number, end: number, readSignal?: AbortSignal) {
      owner.signal.throwIfAborted();
      readSignal?.throwIfAborted();
      const rangeKey = `${start}:${end}`;
      let request = entry.reads.get(rangeKey);
      if (!request) {
        const controller = new AbortController();
        request = {
          controller,
          promise: source.read(start, end, controller.signal),
          consumers: 0,
        };
        entry.reads.set(rangeKey, request);
        const current = request;
        void current.promise
          .finally(() => {
            if (entry.reads.get(rangeKey) === current)
              entry.reads.delete(rangeKey);
          })
          .catch(() => {});
      }
      const current = request;
      current.consumers++;
      const controller = new AbortController();
      const abortOwner = () => controller.abort(owner.signal.reason);
      const abortRead = () => controller.abort(readSignal?.reason);
      owner.signal.addEventListener("abort", abortOwner, { once: true });
      readSignal?.addEventListener("abort", abortRead, { once: true });
      try {
        const bytes = await consume(current.promise, controller.signal);
        controller.signal.throwIfAborted();
        return bytes.slice();
      } finally {
        owner.signal.removeEventListener("abort", abortOwner);
        readSignal?.removeEventListener("abort", abortRead);
        if (--current.consumers === 0) {
          if (entry.reads.get(rangeKey) === current)
            entry.reads.delete(rangeKey);
          current.controller.abort(Error("Byte range has no consumers."));
        }
      }
    },
    dispose: release,
  };
}
