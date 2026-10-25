# Export benchmark

Measured 2026-10-25T12:29:11.195Z on Apple M1, 16 GiB RAM, darwin 27.0.0, Chrome 155.0.8059.86.

Headless Chrome, WebGPU enabled; preview initialized and paused; exports run sequentially. First 720p30 warm-up: 4.352 seconds (excluded from medians); 3 runs per preset with rotating order. Timing includes codec capability check, GPU device and scene setup, all frame rendering/encoding, encoder flush, MP4 muxing, and cleanup. Module loading and download/disk writing are excluded. Each run exports the shipped eight-second composition using the unchanged production export function. The codec chooses its own hardware/software path; GPU adapter metadata does not prove hardware encoding.

| Preset         | Frames | Median time |         Range | Export FPS | Realtime |      Size |
| -------------- | -----: | ----------: | ------------: | ---------: | -------: | --------: |
| 640×360 / 24   |    192 |     0.415 s | 0.413–0.436 s |      463.0 |   19.29× |  1.04 MiB |
| 640×360 / 30   |    240 |     0.518 s | 0.499–0.520 s |      463.2 |   15.44× |  1.41 MiB |
| 640×360 / 60   |    480 |     1.002 s | 0.982–1.034 s |      478.8 |    7.98× |  3.43 MiB |
| 1280×720 / 24  |    192 |     0.850 s | 0.849–0.861 s |      225.9 |    9.41× |  5.42 MiB |
| 1280×720 / 30  |    240 |     1.063 s | 1.060–1.085 s |      225.7 |    7.52× |  7.59 MiB |
| 1280×720 / 60  |    480 |     2.111 s | 2.095–2.370 s |      227.4 |    3.79× | 15.17 MiB |
| 1920×1080 / 24 |    192 |     1.353 s | 1.334–1.355 s |      141.9 |    5.91× |  8.71 MiB |
| 1920×1080 / 30 |    240 |     1.662 s | 1.659–1.665 s |      144.4 |    4.81× | 10.88 MiB |
| 1920×1080 / 60 |    480 |     3.281 s | 3.276–3.291 s |      146.3 |    2.44× | 18.97 MiB |

Realtime is video duration divided by export time; values above 1 are faster than realtime. These measurements apply to this scene workload and machine; browser headless mode, thermals, GPU load, shader complexity and encoder implementations affect results. Successful runs assert frame count and exact duration; this benchmark does not independently decode each MP4. Use npm run test:browser for media playback/decoding validation. Raw measurements and environment are in artifacts/benchmark-export.json.

Reproduce with the Vite dev server running: npm run benchmark:export. Override BENCH_REPEATS, BASE_URL or CHROME_CHANNEL as needed.
