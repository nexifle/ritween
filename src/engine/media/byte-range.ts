import {
  MAX_ASSET_BYTES,
  readAssetResponse,
  resolveAssetUrl,
  withAssetRequest,
} from "./resource";

export const MAX_RANGE_BYTES = 4 * 2 ** 20;

/** One validated network read; callers own the returned bytes. End is exclusive. */
export function fetchAssetRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
  version?: string,
) {
  return withAssetRequest(signal, () =>
    readAssetRange(url, start, end, signal, version),
  );
}

async function readAssetRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
  version?: string,
) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > MAX_ASSET_BYTES ||
    end - start > MAX_RANGE_BYTES
  )
    throw Error("Invalid asset byte range.");
  signal?.throwIfAborted();
  const response = await fetch(resolveAssetUrl(url), {
    signal,
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    headers: {
      Range: `bytes=${start}-${end - 1}`,
      ...(version ? { "If-Range": version } : {}),
    },
  });
  try {
    const etag = response.headers.get("etag");
    const strongEtag =
      etag && /^"[^"\x00-\x20\x7f]*"$/.test(etag) ? etag : null;
    if (version && (response.status !== 206 || strongEtag !== version))
      throw Error("Asset resource version changed during range reading.");
    // A server may ignore Range. Keep the existing bounded full-download fallback.
    if (response.status === 200) {
      const bytes = await readAssetResponse(response, signal);
      if (start >= bytes.byteLength)
        throw Error("Asset byte range exceeds resource length.");
      return {
        bytes,
        start: 0,
        length: bytes.byteLength,
        full: true,
        version: strongEtag,
      };
    }
    if (response.status !== 206)
      throw Error(`Asset range request failed with HTTP ${response.status}.`);
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity")
      throw Error("Encoded range responses are unsupported.");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("content-range") ?? "",
    );
    if (!match) throw Error("Asset has an invalid Content-Range.");
    const [first, last, length] = match.slice(1).map(Number);
    if (
      ![first, last, length].every(Number.isSafeInteger) ||
      first !== start ||
      last !== Math.min(end, length) - 1 ||
      length <= start ||
      length > MAX_ASSET_BYTES
    )
      throw Error(
        "Asset Content-Range does not match the requested range or resource limit.",
      );
    const expectedBytes = Math.min(end, length) - start;
    const bytes = await readAssetResponse(response, signal, expectedBytes);
    if (bytes.byteLength !== expectedBytes)
      throw Error("Asset range response is truncated.");
    return { bytes, start, length, full: false, version: strongEtag };
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
}
