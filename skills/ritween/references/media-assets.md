# Aset audio, gambar, dan video lokal

Gunakan aset yang diberikan pengguna. Jangan mengganti footage/gambar dengan visual prosedural atau BGM/SFX dengan synth tanpa persetujuan pengguna. API ini memerlukan versi Ritween yang benar-benar mengekspornya; periksa tipe paket terpasang sebelum memakai contoh.

## Lokasi file

Letakkan file dalam `public/` milik proyek konsumen. File `public/media/shot.mp4` diakses sebagai `/media/shot.mp4`, bukan `/public/media/shot.mp4` atau path filesystem `/Users/...`. Helper media memakai URL same-origin dan tidak menyediakan upload maupun akses filesystem arbitrer.

## Scene siap pakai

```ts
import { imageScene, videoClip, audioFile, type Project } from "ritween";

export const project: Project = {
  name: "Footage dan gambar",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 8,
  scenes: [
    videoClip({
      id: "opening",
      name: "Opening",
      source: "manifest.ts",
      url: "/media/shot.mp4",
      start: 0,
      trim: { in: 2, out: 7 },
      fit: "cover",
      audio: { muted: false },
    }),
    imageScene({
      id: "closing",
      name: "Closing",
      source: "manifest.ts",
      url: "/media/logo.png",
      start: 5,
      duration: 3,
      fit: "contain",
      transform: ({ localTime }) => ({
        x: 640,
        y: 360,
        width: 600,
        height: 400,
        rotation: localTime * 0.1,
        opacity: Math.min(1, localTime / 0.3),
      }),
    }),
  ],
  audioTracks: [
    {
      id: "music",
      name: "Music",
      clips: [
        {
          id: "bgm",
          name: "BGM",
          start: 0,
          duration: 8,
          create: audioFile({ url: "/media/music.wav", volume: 0.25 }),
        },
      ],
    },
  ],
};
```

Waktu memakai detik. Trim `[in, out)` menentukan durasi video; jangan mendeklarasikan durasi kedua yang berbeda. Transform memakai pixel komposisi, pusat objek `x/y`, rotasi radian, dan opacity 0–1. `contain` mempertahankan seluruh gambar; `cover` mengisi kotak dengan crop. Animasi harus berasal dari waktu timeline, bukan state frame sebelumnya.

Audio footage diturunkan otomatis dengan ID clip video yang sama. Studio menampilkannya sebagai clip audio terkait dengan kontrol mute; mute tidak menghilangkan gambar. Default `audio.muted` dapat di-override oleh `settings.audioClips[id].muted`, termasuk `false`. Perubahan studio disimpan di sidecar proyek dan berlaku saat export. Track mute tetap gerbang tambahan; monitor/master mute hanya memengaruhi preview.

## Resource untuk custom scene WebGPU

Gunakan `videoResource` sebagai descriptor immutable, lalu daftarkan pada `project.mediaClips` atau `scene.mediaClips`. Satu scene boleh menggunakan beberapa video; setiap pemakaian memiliki ID sendiri agar audionya dapat dikontrol secara independen.

```ts
const footage = videoResource({
  id: "screen-video",
  name: "Screen video",
  url: "/media/shot.mp4",
  start: 0,
  duration: 5,
  offset: 2,
  muted: false,
});
```

Di scene:

1. `setup`: panggil `loadVideoTexture(context, footage)` dan/atau `loadImageTexture(context, { url })`, lalu siapkan sampler, bind group, dan pipeline sendiri.
2. `prepareFrame`: tunggu `video.prepareFrame({ time: context.time, signal: context.signal })`. Resource memakai **waktu komposisi**, bukan `localTime`, untuk memetakan `start` dan `offset`.
3. `render`: sample `resource.texture` dalam shader. Posisi, geometry 3D, mask, efek, dan compositing ditentukan scene. Engine yang men-submit command encoder.
4. `dispose`: panggil `dispose()` pada setiap resource dan hancurkan resource GPU milik scene.

Resource video tidak boleh dibagikan antar-renderer/device. Daftar descriptor hanya menghasilkan audio; scene tetap harus memuat dan menggambar texture agar visual muncul. Jangan memakai helper scene layar penuh untuk menumpuk layer; pakai custom scene untuk beberapa texture.

Scene yang memakai persiapan asinkron harus dirender melalui `Renderer.renderAsync()` atau `FrameSource.render()`, bukan `Renderer.render()` sinkron. Preview dan CLI menyediakan jalur asinkron tersebut.

## Batasan dan validasi

Tidak ada dependency decoder media pihak ketiga. Input video memakai pembaca MP4 internal dan WebCodecs browser; format awal ditujukan untuk MP4 non-fragmented H.264 dengan AAC opsional. Ini bukan jaminan semua MP4 bisa dibaca. File terenkripsi, struktur yang belum didukung, dan codec yang tidak tersedia harus menghasilkan error eksplisit.

Pembaca awal menerima paling banyak satu track H.264 `avc1` dan satu track AAC-LC `mp4a.40.2`, masing-masing dengan satu sample description. Edit list dibatasi satu media edit berkecepatan 1, dengan satu leading empty edit opsional. Fragmented MP4, enkripsi, rotasi/transform bawaan track, pixel aspect nonpersegi, clean aperture, dan struktur lain yang belum didukung ditolak secara eksplisit. Normalisasikan aset tersebut di luar Ritween sebelum digunakan.

File tanpa audio harus tetap dapat ditampilkan. Jangan menganggap AAC tersedia hanya karena video H.264 dapat didecode. Audio file memakai decoder browser melalui managed audio context; format yang tersedia bergantung pada browser.

Batas resource awal:

- Download maksimal **128 MiB per aset**; URL harus HTTP(S), same-origin, tanpa redirect.
- PCM sumber maksimal **128 MiB**, dan stereo mix offline maksimal **256 MiB**.
- Texture media maksimal **64 MiB total per GPUDevice**, bukan per clip. Renderer menyiapkan seluruh scene secara eager, sehingga texture dari scene yang belum aktif juga memakai anggaran ini. File yang sama dalam resource berbeda memakai texture terpisah.
- Dimensi texture tetap dibatasi perangkat; decoding video dibatasi maksimal 2.048 sample per GOP.

Pecah proyek atau turunkan resolusi aset bila melewati batas. Jangan menjanjikan footage dengan durasi atau jumlah aset tanpa batas.

Periksa frame sebelum/sesudah cut, seek maju-mundur dalam renderer yang sama, transform gambar, sinkronisasi marker visual/audio, mute/unmute dan reload settings, lalu decode hasil MP4. PNG tidak membuktikan audio; build tidak membuktikan browser decode atau export. Laporkan format dan kasus yang benar-benar diuji.
