export type ExportPipeline = "parallel" | "sequential";

/** Own both jobs: preserve the first error and await sibling cleanup before returning. */
export async function runExportPipelines<A, V>(
  mode: ExportPipeline,
  parent: AbortSignal | undefined,
  audio: (signal: AbortSignal) => Promise<A>,
  video: (signal: AbortSignal) => Promise<V>,
): Promise<[A, V]> {
  if (mode !== "parallel" && mode !== "sequential")
    throw Error(`Unsupported export pipeline: ${mode}`);
  parent?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  const run = async <T>(job: (signal: AbortSignal) => Promise<T>) => {
    try {
      controller.signal.throwIfAborted();
      return await job(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    }
  };
  try {
    if (mode === "sequential") {
      const a = await run(audio);
      const v = await run(video);
      controller.signal.throwIfAborted();
      return [a, v];
    }
    const [a, v] = await Promise.allSettled([run(audio), run(video)]);
    controller.signal.throwIfAborted();
    if (a.status === "rejected") throw a.reason;
    if (v.status === "rejected") throw v.reason;
    return [a.value, v.value];
  } finally {
    parent?.removeEventListener("abort", abort);
  }
}
