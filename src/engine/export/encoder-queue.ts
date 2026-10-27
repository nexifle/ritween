/** Wait for codec capacity without flushing its pipeline between batches. */
export async function waitForEncoderCapacity(
  encoder: EventTarget & { readonly encodeQueueSize: number },
  limit: number,
  signals: readonly (AbortSignal | undefined)[],
) {
  for (const signal of signals) signal?.throwIfAborted();
  if (encoder.encodeQueueSize < limit) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      encoder.removeEventListener("dequeue", check);
      for (const signal of signals) signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signals.find((signal) => signal?.aborted)?.reason);
    };
    const check = () => {
      if (encoder.encodeQueueSize >= limit) return;
      cleanup();
      resolve();
    };
    encoder.addEventListener("dequeue", check);
    for (const signal of signals)
      signal?.addEventListener("abort", abort, { once: true });
    // Recheck after registration; no polling or lost capacity notifications.
    if (signals.some((signal) => signal?.aborted)) abort();
    else check();
  });
}
