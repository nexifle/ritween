export const MAX_ASSET_BYTES = 128 * 2 ** 20;

/** Resolve only same-origin HTTP(S) asset URLs; file URLs are never fetchable. */
export function resolveAssetUrl(input: string, baseHref?: string) {
  if (typeof input !== "string" || input.trim() === "")
    throw Error("Asset URL must be a non-empty string.");
  const base = baseHref ?? globalThis.location?.href;
  if (!base) throw Error("Asset loading requires a browser origin.");

  let baseUrl: URL;
  let url: URL;
  try {
    baseUrl = new URL(base);
    url = new URL(input, baseUrl);
  } catch {
    throw Error("Asset URL is invalid.");
  }
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== baseUrl.origin ||
    url.username !== "" ||
    url.password !== ""
  )
    throw Error("Only same-origin HTTP(S) assets are supported.");
  return url;
}

function contentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw Error("Asset has an invalid Content-Length.");
  const length = Number(value);
  if (!Number.isSafeInteger(length))
    throw Error("Asset Content-Length exceeds the safe integer range.");
  if (length > MAX_ASSET_BYTES)
    throw Error("Asset exceeds the 128 MiB encoded resource limit.");
  return length;
}

/** Stream with a hard byte limit instead of buffering an untrusted body first. */
export async function readAssetResponse(
  response: Response,
  signal?: AbortSignal,
  maxBytes = MAX_ASSET_BYTES,
) {
  let advertised: number | null;
  try {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw Error("Asset byte limit must be a positive safe integer.");
    if (!response.ok)
      throw Error(`Asset request failed with HTTP ${response.status}.`);
    advertised = contentLength(response);
    if (advertised !== null && advertised > maxBytes)
      throw Error(
        `Asset exceeds the ${Math.floor(maxBytes / 2 ** 20)} MiB encoded resource limit.`,
      );
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }

  const reader = response.body?.getReader();
  if (!reader)
    throw Error("Asset response does not support bounded streaming.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > maxBytes - length) {
        await reader.cancel().catch(() => {});
        throw Error(
          `Asset exceeds the ${Math.floor(maxBytes / 2 ** 20)} MiB encoded resource limit.`,
        );
      }
      chunks.push(value);
      length += value.byteLength;
    }
    signal?.throwIfAborted();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** Fetch a same-origin asset with both header and streamed-body size limits. */
export async function fetchAsset(url: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const resolved = resolveAssetUrl(url);
  const response = await fetch(resolved, {
    signal,
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
  });
  return readAssetResponse(response, signal);
}
