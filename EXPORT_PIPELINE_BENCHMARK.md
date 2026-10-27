# Audio/video pipeline benchmark

Historical measurements: these runs predate GOP/quality-mode export defaults. Re-run before comparing encoding size or timing with the current exporter.

Measured 2026-10-26T14:55:46.234Z on Apple M1, 16 GiB RAM, darwin 27.0.0, Chrome 155.0.8059.86.

3 measured runs per project/cache/pipeline combination, after one full warmup per pipeline. Workloads run one at a time in headless Chrome, at 30 FPS: demo 1280×720 (8 s), video9 working copy 720×1280 (90 s). Both modes use the same production render/encoding code; only scheduling differs. Pipeline order alternates between rounds and cache cases.

| Workload | PCM cache | Sequential median (range) | Parallel median (range) | Parallel improvement | First submitted video frame, sequential / parallel |
|---|---|---:|---:|---:|---:|
| demo | cold | 0.980 s (0.978–0.983) | 0.904 s (0.900–0.916) | 7.8% | 0.100 / 0.017 s |
| demo | warm | 0.955 s (0.952–0.961) | 0.904 s (0.894–0.907) | 5.3% | 0.076 / 0.017 s |
| video9 | cold | 22.464 s (21.660–23.023) | 13.954 s (13.781–13.970) | 37.9% | 10.961 / 0.237 s |
| video9 | warm | 11.697 s (11.661–11.724) | 11.170 s (11.153–11.325) | 4.5% | 0.752 / 0.222 s |

Positive improvement means parallel was faster. Cold means a fresh PCM cache key; source WAV bytes, browser/OS caches and shaders are already primed. Warm means the PCM mix is explicitly prepared before the timer, as a repeat export would reuse it. Every trial uses a new project object, and explicit GC between trials releases prior blobs/weak-cache entries. The cold result includes graph compilation, asset decoding, mixing, AAC, GPU/encoder setup, all video frames, flushing, muxing and cleanup. Module loading, warm-cache preparation and downloading/writing the file are outside the timer.

All samples check frame count and duration. Last cold outputs from each pipeline are saved and fully decoded after all timing runs.

- demo: frame/stream durations valid; decoded audio identical: true; decoded video frame hashes identical: true.
- video9: frame/stream durations valid; decoded audio identical: false; decoded video frame hashes identical: true.

No hardware-encoding or peak-memory claim is made. Queue bounds are unchanged, but concurrent jobs can overlap allocations; the heartbeat measures event-loop delay, not end-to-end UI latency. Timing is workload/machine-specific, and these small repeated samples do not establish a confidence interval.

Raw samples, stage timelines, warmups, environment, heartbeat delays and decode hashes: [benchmarks/export-pipelines.json](benchmarks/export-pipelines.json).

Reproduce from the repository root: `BENCH_REPEATS=3 node scripts/benchmark-pipelines.mjs ../video9`. Requires Chrome and ffmpeg/ffprobe.

The video9 working copy had a pre-existing two-line change in `scene6.ts`; it was preserved and used by both modes. This task did not alter the project.

The independent video9 cold outputs are not bit-identical in audio. Their decoded audio has equal sample counts, correlation **0.9999999517**, RMS difference **3.98e-5**, and difference SNR **70.15 dB** (maximum instantaneous difference **0.01386**). The best correlation among offsets ±4 sample frames occurs at zero. Video frame hashes are identical.

A separate five-export trace captured the actual PCM sent to AudioEncoder. A second sequential cold render differed from the first by at most **1.79e-7**, RMS **6.05e-9**; parallel cold differed by at most **1.79e-7**, RMS **5.77e-9**. Both retained the same AAC chunk count and first/last timestamps. When both modes reused the same PCM buffer, **PCM and encoded AAC hashes were identical**, including comparison to the first sequential export. Thus the observed cold-render differences also occur within the sequential baseline; the encoded outputs are not universally bit-exact across independent mixes. These tests do not constitute a listening test or prove equivalence for every possible author schedule.

Repeatability data is included in the raw JSON under `audioRepeatability`. Reproduce separately with `node scripts/diagnose-pipeline-audio.mjs ../video9`; the trace is excluded from all timing measurements.

Based on these workloads, **parallel is the default**. The API retains `pipeline: "sequential"` for controlled comparisons. PCM cache reuse narrows the total-time advantage, while the first video frame still starts earlier. Warm video9 heartbeat delay was higher in parallel (median worst delay **53.0 ms** vs **34.9 ms**), so lower total time does not imply every responsiveness metric improves.
