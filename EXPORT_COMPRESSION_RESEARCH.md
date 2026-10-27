# Riset kompresi export Rimotion

Catatan: audit dan benchmark di bawah merekam baseline sebelum perubahan produksi. Implementasi GOP beserta validasinya dijelaskan dalam [EXPORT_COMPRESSION_IMPLEMENTATION.md](EXPORT_COMPRESSION_IMPLEMENTATION.md).

Tanggal: 27 Oktober 2026. Fokus: Full HD (termasuk portrait 1080×1920), 60 FPS, 90 detik/5400 frame, dengan audio. Riset ini mengaudit kode lokal, membaca sumber primer internet, dan menguji encoder browser pada scene video9. Tidak mengubah exporter produksi.

## Temuan utama

Masalah paling mendasar adalah **semua frame dipaksa menjadi keyframe**. Exporter tidak memakai prediksi antarframe yang sangat berguna untuk motion graphic. Bitrate, mode encoding, dan muxer juga perlu diperbaiki bersama. Mengganti browser, menambahkan FFmpeg WASM, atau mengompresi audio bukan langkah pertama yang tepat berdasarkan audit ini.

Bukti lokal:

- `src/engine/export.ts`: `encoder.encode(frame, { keyFrame: true })` untuk setiap frame.
- `src/engine/mp4.ts`: `add()` menolak semua non-keyframe; tabel `stss` mencatat setiap sampel sebagai sync sample. Muxer membuang timestamp chunk dan mengasumsikan durasi satu tick per sampel.
- Konfigurasi video: `avc1.42002a` (H.264 Baseline, Level 4.2), `latencyMode: "realtime"`, dan `bitrate = width × height × fps × 0.22`.
- Full HD 60 FPS menghasilkan target **27.371.520 bit/s**. Target bitrate itu sendiri setara sekitar **307,93 MB video/90 detik**, sebelum audio dan overhead. Target VBR bukan batas ukuran mutlak.
- Audio sudah dicampur menjadi satu soundtrack AAC-LC, 128 kbps. Banyak klip sumber tidak otomatis menjadi banyak stream dalam MP4. Pada 90 detik, anggaran audio hanya sekitar **1,44 MB**.

File asli sekitar 600 MB tidak ditemukan dalam direktori contoh, sehingga ukuran file asli tersebut belum diverifikasi langsung. Baseline pada sampel video9 menghasilkan bitrate aktual sekitar 50,97 Mbps (lihat pengujian di bawah). Ukuran 600 MB/90 detik berarti bitrate total sekitar 53,33 Mbps (atau 55,92 Mbps bila yang dimaksud 600 MiB). Ini lebih tinggi dari target kode saat ini. Perbedaan versi exporter, overshoot encoder, atau konten aktual harus dibedakan melalui `ffprobe`; penyebab selisih tersebut belum dapat dipastikan.

Sebagai bukti terpisah, `../video9/video_compressed.mp4` yang sudah ada memiliki **36.608.732 byte**, 1080×1920, 60 FPS, 90 detik, 5400 frame. Codec video HEVC Main sekitar 3,125 Mbps; audio AAC sekitar 115 kbps. Ini menunjukkan file jauh lebih kecil sudah ada pada kasus ini, tetapi tanpa sumber lossless dan riwayat encoding saya tidak menyimpulkan kualitasnya setara.

## Pengujian browser langsung

Harness: `scripts/research-compression.mjs`. Hasil mentah di `artifacts/compression-research/results.json`. Menggunakan `Renderer` produksi dan manifest video9, tidak mentranskode file HEVC yang sudah dikompresi.

Sampel: enam cuplikan masing-masing 2 detik, dimulai pada detik 0, 27, 42, 56, 73, dan 85. Total 720 frame, 12 detik, 1080×1920/60 FPS. Tiap awal cuplikan menjadi keyframe. Ini sampel beberapa scene, bukan seluruh timeline dan belum mencakup semua transisi. Tiga putaran, urutan dibalik pada putaran kedua. Manifest diimpor melalui path project eksternal yang eksplisit; hasil mentah menyimpan nama dan durasi project sebagai pemeriksaan identitas. Tidak ada warmup terpisah; laporkan median dan rentang, bukan klaim peningkatan yang pasti berlaku di perangkat lain.

Output pengujian berupa elementary stream H.264 Annex B; **belum MP4 delivery dan tanpa audio**. Waktu mencakup setup renderer, render, fence GPU, encode dan flush. Serialisasi base64, penulisan disk, muxing dan mixing audio dikecualikan. Fence GPU, queue maksimal 4 dan yield setiap empat frame dipertahankan. Identitas hardware encoder tidak diukur.

| Konfigurasi | MB video | Median detik | Rentang detik | Keyframe |
|---|---:|---:|---:|---:|
| all-intra-27m | 76.454 | 5.219 | 5.183–8.514 | 720 |
| gop-27m | 14.806 | 5.235 | 5.205–5.245 | 6 |
| gop-6m | 6.564 | 5.188 | 5.181–5.199 | 6 |
| gop-quality-6m | 8.206 | 4.438 | 4.436–4.454 | 6 |
| gop-quality-qp24 | 7.317 | 5.215 | 5.208–5.216 | 6 |

Lingkungan: Apple M1, Chrome 155.0.8059.86. Ukuran identik pada tiga putaran masing-masing konfigurasi. GOP 27 Mbps mengurangi ukuran sampel **80,6%**; GOP realtime 6 Mbps **91,4%**; GOP quality 6 Mbps **89,3%**; QP 24 **90,4%**. GOP 27 Mbps memiliki median waktu hampir sama dengan all-intra. Mode quality 6 Mbps sekitar 15% lebih cepat pada pengujian ini, tetapi menghasilkan file lebih besar daripada realtime 6 Mbps. Jadi pengaturan latency tidak boleh dianggap menjamin file lebih kecil.

Baseline all-intra menghasilkan bitrate aktual sekitar **50,97 Mbps**, walaupun target 27,37 Mbps. Ekstrapolasi ukuran sampel itu ke 90 detik sekitar **573 MB video**. Ini bukan ukuran baseline seluruh timeline yang sudah diukur, tetapi selaras dengan keluhan file sekitar 600 MB.

Seluruh angka dari percobaan awal yang salah mengimpor demo telah dibuang; tabel ini hanya memakai hasil yang menyimpan identitas manifest video9.

### Pemeriksaan kualitas terhadap renderer

Enam frame pada detik 0,5; 27,5; 42,5; 56,5; 73,5; dan 85,5 dibandingkan dengan snapshot PNG lossless renderer pada waktu yang sama. Kedua sisi dikonversi FFmpeg ke YUV444 untuk perhitungan SSIM; hasil termasuk pengaruh konversi warna dan subsampling encoder. Ini **bukan** pengujian temporal seluruh video.

| Konfigurasi | SSIM luma Y | SSIM seluruh kanal |
|---|---:|---:|
| all-intra-27m | 0.999013 | 0.993812 |
| gop-27m | 0.999420 | 0.994432 |
| gop-6m | 0.993905 | 0.989667 |
| gop-quality-6m | 0.998947 | 0.992981 |
| gop-quality-qp24 | 0.998314 | 0.992376 |

Mode quality 6 Mbps mendekati baseline all-intra pada enam frame ini, terutama luma yang memuat detail teks. Realtime 6 Mbps lebih kecil tetapi SSIM lebih rendah; ukuran paling kecil tidak otomatis menjadi pilihan terbaik. Pemeriksaan visual pada frame chart detik 56,5 juga mempertahankan keterbacaan teks, bentuk bar dan garis. Belum ada penilaian playback penuh atau VMAF seluruh timeline; kualitas setara secara menyeluruh belum dibuktikan. Hasil mentah: `artifacts/compression-research/still-quality.json`. Reproduksi: `node scripts/research-compression-quality.mjs` setelah benchmark sampel selesai.

Semua kandidat sampel didecode untuk ekstraksi frame. MP4 video-only seluruh timeline juga didecode dan dikonfirmasi **5400 frame, 90,000 detik, 1080×1920/60 FPS**, ukuran **65.748.649 byte**, dalam `artifacts/compression-research-full/decode-check.json`.

### Eksperimen seluruh timeline

Satu run tambahan pada seluruh video9 menggunakan H.264 Baseline, GOP 2 detik, mode quality, target VBR 6 Mbps, 1080×1920/60 FPS. Hasil: **5400 frame, 45 keyframe, 65.725.030 byte video (65,725 MB), 38,096 detik**. Timestamp output monoton. Ini satu run, bukan median. Audio, muxing, serialisasi base64 dan penulisan file dikecualikan dari timer. Identitas project tersimpan dalam hasil mentah `artifacts/compression-research-full/results.json`.

Stream kemudian diremux dengan FFmpeg menjadi MP4 video-only untuk pemeriksaan decode. Ini tidak membuktikan muxer produksi sekarang mampu menulis GOP. Dengan anggaran audio 128 kbps/90 detik, perkiraan ukuran audiovisual berdasarkan run ini **67,17 MB plus overhead**; audio belum digabungkan dan itu bukan ukuran akhir audiovisual yang sudah diukur. Berkas MP4 video-only tersedia di `artifacts/compression-research-full/gop-quality-6m-video-only.mp4`.

Seluruh timeline berhasil disubmit; decode dan frame count diperiksa terpisah. Ukuran dan waktu tidak boleh digunakan sebagai jaminan untuk project lain.

## Perbaikan browser yang direkomendasikan

### 1. Dukung GOP sebelum menurunkan kualitas

Target awal: keyframe setiap 2 detik, serta pada cut yang diketahui dari manifest. Pada 60 FPS, interval reguler 120 frame. Mintalah keyframe pada frame pertama dan titik tersebut; biarkan encoder menentukan frame lainnya. `keyFrame: false` tidak menjamin chunk bukan keyframe, jadi metadata output tetap harus dipercaya.

Apple menjelaskan bahwa keyframe mereset ketergantungan antarframe dan interval 1 berarti semua frame menjadi keyframe. Mediabunny juga mendokumentasikan bahwa keyframe lebih sering memperbaiki seeking tetapi memperbesar file, dengan default interval 2 detik. [Apple VideoToolbox](https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_maxkeyframeinterval), [Mediabunny media sources](https://mediabunny.dev/guide/media-sources).

Riset source Chromium juga menunjukkan pemetaan bitrate ke VideoToolbox serta pembatasan penggunaan `DataRateLimits` bersama mode low-latency. Apple membedakan target average bitrate dari hard data-rate limits. Ini memperkuat alasan mengukur byte aktual dan tidak menganggap angka `bitrate` sebagai plafon. Jalur hardware aktual run ini belum ditelusuri, sehingga saya tidak menetapkan source tersebut sebagai bukti penyebab overshoot spesifik. [Source Chromium](https://chromium.googlesource.com/chromium/src/media/+/dc6797fc9e26d09bc017ac3edac02d6c64503c8c/gpu/mac/vt_video_encode_accelerator_mac.mm), [Apple DataRateLimits](https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_dataratelimits).

**Mengubah satu baris `keyFrame` saja akan membuat export sekarang gagal**, karena muxer menolak delta frame. Pilih salah satu:

1. Perluas muxer minimal untuk I/P dengan urutan decode = urutan presentasi: simpan flag key per sampel, tulis `stss` hanya untuk sync sample, validasi timestamp, durasi, sample count dan decoder configuration. H.264 Baseline bisa menjadi jalur konservatif awal.
2. Gunakan muxer yang sudah menangani timestamp dan ketergantungan paket, terutama jika ingin H.264 High, HEVC, atau frame reordering. Rekomendasi saya: evaluasi **Mediabunny untuk muxing dahulu**, sambil mempertahankan renderer dan kontrol WebCodecs yang sudah ada.

Untuk frame reordering, `stts` saja tidak cukup; perlu pemetaan decode/presentation timing yang benar, termasuk composition offsets bila relevan. Jangan mengasumsikan urutan callback selalu cocok dengan posisi presentasi pada semua codec/profil. AAC priming/edit list yang sekarang dipakai harus tetap diuji saat migrasi.

### 2. Gunakan mode untuk export file

Kandidat konfigurasi awal, **setelah muxer diperbaiki**:

```ts
const config: VideoEncoderConfig = {
  codec: "avc1.42002a", // profil awal yang sama untuk mengisolasi perubahan GOP
  width, height, framerate: fps,
  bitrate: 6_000_000, // titik awal kalibrasi 1080p60, bukan jaminan kualitas
  bitrateMode: "variable",
  latencyMode: "quality",
  hardwareAcceleration: "no-preference",
  avc: { format: "avc" },
};
const support = await VideoEncoder.isConfigSupported(config);
// Validasi support.supported dan properti yang dipertahankan support.config.
// Pada render loop:
encoder.encode(frame, { keyFrame: i === 0 || i % (fps * 2) === 0 || isCutFrame });
```

Dalam spesifikasi WebCodecs, VBR sudah merupakan default. Jadi menulis `bitrateMode: "variable"` membuat intent eksplisit, tetapi bukan perubahan perilaku utama dari kode sekarang. `quality` mengutamakan kualitas dan melarang drop frame demi target bitrate/framerate; `realtime` boleh mengorbankan kualitas dan drop frame. Preferensi hardware hanyalah hint, bukan bukti encoder hardware aktif. [WebCodecs](https://www.w3.org/TR/webcodecs/).

Probe profil H.264 Main/High sebagai eksperimen berikutnya, dengan fallback Baseline. Jangan mengganti codec string dan menganggap muxer lama otomatis kompatibel. Evaluasi hasil nyata, bukan hanya `isConfigSupported()`.

### 3. Tambahkan kontrol kualitas dan target ukuran sebagai dua mode berbeda

- **Target bitrate/size:** cocok bila pengguna mempunyai batas upload. Hitung `video_bps = target_bytes × 8 / duration − audio_bps − overhead_budget`. Ini perkiraan anggaran; bukan hard limit VBR. Hard cap membutuhkan validasi ukuran akhir dan retry atau backend dengan pengaturan rate control lebih ketat.
- **Target kualitas:** probe `bitrateMode: "quantizer"`; untuk AVC, QP dapat diberikan per frame melalui `avc: { quantizer }`. Mulai sweep 20/24/28, lalu pilih berdasarkan evaluasi. Ukuran mengikuti kompleksitas video.

QP WebCodecs **tidak sama dengan CRF x264/x265**. Constant QP mengontrol kuantisasi langsung; CRF mempunyai algoritme rate control dan penyesuaian kualitas dari encoder. Angka 24 tidak dapat dipindahkan antarcodec atau encoder sebagai kualitas identik. FFmpeg mendokumentasikan `crf` dan `qp` sebagai opsi berbeda. [AVC WebCodecs Registration](https://w3c.github.io/webcodecs/avc_codec_registration.html), [FFmpeg codecs](https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb).

Mediabunny saat ini menyediakan API kualitas dengan quantizer dan fallback bitrate. Ini membantu abstraksi capability, tetapi tidak membuat semua browser menyediakan encoder yang sama. Periksa versi API saat integrasi; field `quality` menggantikan pola lama `bitrate: QUALITY_*`. [Pengumuman quantizer Mediabunny](https://mediabunny.dev/blog/quantizer-support).

Anggaran nominal untuk 90 detik, AAC 128 kbps, belum overhead:

| Video bitrate rata-rata | Ukuran total perkiraan, MB desimal |
|---:|---:|
| 3 Mbps | 35,19 |
| 4 Mbps | 46,44 |
| 6 Mbps | 68,94 |
| 8 Mbps | 91,44 |
| 12 Mbps | 136,44 |
| 27,37152 Mbps | 309,37 |

Tabel adalah aritmetika anggaran, **bukan prediksi kualitas** atau hasil benchmark penuh. Pada motion graphic sederhana, VBR aktual bisa lebih kecil; partikel, noise, grain, atau gerak kompleks bisa membutuhkan lebih banyak bit.

## Pilihan codec dan backend

| Jalur | Kegunaan | Batasan / keputusan |
|---|---|---|
| Browser WebCodecs H.264 + GOP | Pilihan utama untuk export cepat dan kompatibilitas luas | Perbaiki muxer; kalibrasi VBR/QP; probe runtime |
| Browser WebCodecs HEVC | Opsi ukuran lebih kecil pada lingkungan yang mendukung | Encoding dan playback harus diprobe terpisah; perlu sample entry/config HEVC pada MP4 |
| Browser WebCodecs AV1/VP9 | Opsi tambahan bila runtime mendukung | Kecepatan dan kompatibilitas delivery harus diuji; jangan menjanjikan AV1 hardware untuk semua perangkat |
| Native FFmpeg x264 CRF | Kontrol compression/quality lebih matang untuk CLI | Software encoding memakai CPU; ukur end-to-end termasuk transport frame |
| Native FFmpeg VideoToolbox HEVC/H.264 | Kandidat cepat di Apple Silicon | Kualitas per byte berbeda dari encoder software; ukur, jangan menyamakan `-q:v` dengan CRF |
| Native x265 / SVT-AV1 | Mode ukuran kecil dengan waktu lebih longgar | Biasanya membutuhkan eksperimen speed/quality lebih banyak; tidak otomatis pilihan tercepat |
| FFmpeg WASM | Fallback khusus jika codec native browser tidak memadai | Bukan rekomendasi utama untuk export 1080p60 yang mengejar kecepatan |

Mediabunny mencatat dukungan container dan codec, tetapi encoder aktual tetap bergantung lingkungan. `@mediabunny/server` menawarkan backend NodeAV/FFmpeg dan deteksi hardware di server; ini opsi integrasi, **bukan pengganti langsung renderer WebGPU browser** dan belum diuji pada repo ini. [Format dan codec Mediabunny](https://mediabunny.dev/guide/supported-formats-and-codecs), [Mediabunny server](https://mediabunny.dev/guide/extensions/server).

Pengelola `mp4-muxer` lama telah mendeprekasinya dan menyarankan Mediabunny. Jadi jangan menambah dependency lama itu untuk pekerjaan baru. [Repository resmi mp4-muxer](https://github.com/Vanilagy/mp4-muxer).

Benchmark resmi ffmpeg.wasm memperlihatkan native FFmpeg 5,2 detik versus WASM single-thread 128,8 detik dan multi-thread 60,4 detik pada workload mereka. Angka tersebut **bukan benchmark Rimotion** atau rasio universal; cukup menjadi alasan menghindari migrasi WASM tanpa bukti lokal. [Benchmark resmi ffmpeg.wasm](https://ffmpegwasm.netlify.app/docs/performance/).

## Kecepatan dan penggunaan memori

1. **Kompresi sekali langsung dari renderer.** Hindari default berupa export besar lalu transcode; itu menambah decode/encode, I/O dan kehilangan kualitas generasi kedua. Transcode tetap berguna sebagai solusi sementara untuk file lama.
2. **Stream output ke file.** Sekarang chunk disalin pada callback encoder, disalin lagi di `MP4Muxer.add()`, dan ditahan sampai finalisasi. Hilangkan salinan yang tidak perlu dengan ownership jelas, lalu pertimbangkan output streaming. Ini mengurangi RAM dan tekanan garbage collector, bukan otomatis bitrate.
3. **Gunakan muxer streaming dengan benar.** `StreamTarget` Mediabunny dapat menulis langsung ke File System API. Output dapat mengandung penulisan ulang pada byte offset tertentu; jangan sekadar concatenate chunk kecuali mode format benar-benar append-only. Atur backpressure sampai sumber. [Writing media files](https://mediabunny.dev/guide/writing-media-files).
4. **Worker untuk respons UI.** `OffscreenCanvas`, renderer dan pengelolaan chunk dapat dipindahkan ke worker. WebCodecs sudah asynchronous; worker tidak otomatis memberi rasio kompresi atau speedup tertentu. Audit akses DOM pada scene dan loading aset dahulu. [Panduan Chrome WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs).
5. **Uji pipeline GPU secara terpisah.** `await queue.onSubmittedWorkDone()` tiap frame mengurangi overlap, tetapi jangan dihapus sebelum memvalidasi snapshot canvas, sinkronisasi tekstur dan frame yang dihasilkan. Bandingkan ring buffer/fence per batch dengan decode dan referensi visual. Semantik fence dijelaskan dalam [spesifikasi WebGPU](https://gpuweb.github.io/gpuweb/).
6. **Pertahankan bounded encoder queue.** Queue lebih besar bukan otomatis lebih cepat; ukur 4/8/16 sebagai eksperimen dengan peak memory dan responsiveness. Jangan flush setiap frame karena mengganggu pipeline.
7. **Pertahankan audio/video parallel yang sudah ada.** Benchmark repo menunjukkan keuntungan bergantung cache. Benchmark lama memakai 720×1280/30 FPS; tidak boleh disebut bukti timing 1080×1920/60 FPS.

Jika CLI mengirim raw RGBA 1080×1920/60 FPS dari browser ke native encoder, payload mentah mencapai sekitar **497,7 MB/detik**, atau 44,8 GB selama 90 detik. Per-frame JSON/base64 atau PNG sequence dapat menjadi bottleneck baru. Rancang transport biner dengan backpressure, atau gunakan jalur GPU/native yang terintegrasi bila tersedia. Jangan mengklaim zero-copy tanpa mengukur keseluruhan rantai.

Tidak perlu memodifikasi atau mem-fork browser sekarang. Kontrol yang dibutuhkan untuk langkah awal tersedia melalui API standar. Akses VideoToolbox/NVENC/QSV yang lebih rinci lebih masuk akal ditempatkan pada backend native opsional daripada flag browser tersembunyi.

## Perintah praktis untuk file lama

Contoh berikut adalah titik awal eksperimen yang belum dibenchmark di mesin ini. Gunakan nama output baru. AAC yang sudah cocok dapat disalin agar tidak mengalami encode ulang.

```bash
# Kompatibilitas luas, pertahankan resolusi dan FPS input
ffmpeg -i input.mp4 -map 0:v:0 -map '0:a?' \
  -c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p \
  -c:a copy -movflags +faststart output-h264.mp4

# Ukuran sebagai prioritas, backend software HEVC
ffmpeg -i input.mp4 -map 0:v:0 -map '0:a?' \
  -c:v libx265 -preset medium -crf 25 -tag:v hvc1 \
  -pix_fmt yuv420p -c:a copy -movflags +faststart output-hevc.mp4

# Kandidat cepat pada macOS yang mendukung VideoToolbox
ffmpeg -i input.mp4 -map 0:v:0 -map '0:a?' \
  -c:v hevc_videotoolbox -b:v 4M -tag:v hvc1 \
  -c:a copy -movflags +faststart output-hevc-hardware.mp4
```

Jangan menganggap CRF 21 H.264 = CRF 25 HEVC, atau target bitrate menjamin kualitas tertentu. `-tune animation` boleh diuji A/B pada material animasi, tetapi tidak otomatis cocok untuk semua motion graphic 3D, tipografi dan gradien. `faststart` memindahkan metadata agar playback bisa mulai lebih awal; itu bukan metode utama mengecilkan data video. [FFmpeg codecs](https://ffmpeg.org/ffmpeg-codecs.html), [FFmpeg MP4 muxer](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv).

## Urutan implementasi dan kriteria penerimaan

1. **P0 — GOP + muxer + opsi encoding.** Pertahankan 1080p60 dan audio 128 kbps. Tambahkan pengaturan bitrate, latency mode dan keyframe interval pada API/CLI/UI; fallback capability harus eksplisit. Jaga cancellation, progress, audio priming dan hasil deterministic sesuai kontrak yang sudah ada.
2. **P1 — kalibrasi kualitas.** Uji H.264 GOP dengan 4/6/8/12 Mbps dan QP 20/24/28 pada seluruh video9, termasuk cut. Bandingkan profil High bila tersedia. Pilih preset setelah inspeksi kualitas.
3. **P2 — streaming dan memori.** Ukur peak RSS/browser memory, waktu finalize, bytes copied dan durasi save. Hindari mengubah terlalu banyak bagian sebelum pengaruh GOP terisolasi.
4. **P3 — HEVC opsional dan native CLI.** Tambahkan hanya jika benchmark menunjukkan manfaat terhadap kebutuhan delivery pengguna. AV1 merupakan eksperimen berikutnya, bukan prerequisite.

Kriteria verifikasi: 5400 frame/90 detik pada 60 FPS; decode seluruh file tanpa error; seek di dekat cut dan ujung file; tidak ada frame hilang/duplikat; audio sync pada awal, tengah dan akhir; AAC priming tetap benar; metadata warna/aspect/resolusi benar; ukuran final dan timing end-to-end dilaporkan bersama lingkungan, warmup, cache dan rentang hasil. Uji browser/perangkat sasaran, tidak hanya encoder mesin pengembang.

Referensi kualitas sebaiknya frame renderer lossless dengan konversi warna yang konsisten. Gunakan SSIM/PSNR dan VMAF per scene, termasuk persentil rendah, kemudian periksa visual pada zoom 100% dan playback bergerak. VMAF adalah alat penilaian perseptual, bukan sertifikat bahwa teks kecil dan grafik selalu sempurna. [Netflix VMAF](https://github.com/Netflix/vmaf), [FFmpeg quality filters](https://ffmpeg.org/ffmpeg-filters.html#libvmaf).

Reproduksi sampel: `node scripts/research-compression.mjs` dari root repo; membutuhkan Chrome, WebGPU dan project `../video9`. Untuk eksperimen satu konfigurasi pada seluruh timeline: `RESEARCH_FULL=1 node scripts/research-compression.mjs`. Harness riset menyimpan encoded stream di memori dan mengirim base64 setelah timer berhenti; itu bukan rancangan transport produksi yang disarankan.
