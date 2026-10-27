# Logo Ritween — Filosofi, Makna, dan Konstruksi Visual

Dokumen ini menjelaskan konsep desain, filosofi simbolik, dan spesifikasi teknis di balik logo resmi **Ritween** (*R-Sprout Keyframe*).

---

## 1. Filosofi & Makna ("Source to Motion")

Tagline utama Ritween adalah **"Source to motion"** dan **"Code authored. Frame perfect."**—sebuah kerangka kerja video berbasis kode di mana struktur deklaratif bertumbuh menjadi gerakan visual yang hidup, presisi, dan organik di atas WebGPU.

Nama **Ritween** berakar dari konsep **in-betweening (*tweening*)** dalam dunia animasi: proses menghidupkan transisi di antara titik-titik kunci (*keyframes* / *anchor points*).

Logo **R-Sprout Keyframe** merangkum identitas tersebut melalui empat lapisan makna:

1. **Monogram "R" yang Organik**: Siluet keseluruhan membentuk huruf **R** kapital (inisial *Ritween*) secara alami tanpa terlihat kaku seperti tipografi biasa.
2. **Tangkai & Tunas Daun (*Source to Organic Growth*)**: Tangkai vertikal yang melengkung di sisi kiri dan helai daun solid di bagian kanan atas melambangkan bagaimana kode sumber (*source*) bertumbuh menjadi karya visual yang hidup (*living motion*).
3. **In-Betweening & Kurva Bézier**: Perpaduan antara garis lengkung (*stroke*) dan bentuk daun utuh (*solid fill*) merepresentasikan proses interpolasi/*tweening*—perubahan dari kerangka garis lintasan (*motion path*) menjadi bentuk visual akhir yang utuh.
4. **Anchor Point / Keyframe Node (Diamond)**: Kaki kanan bawah huruf **R** dirancang sebagai cabang garis handle yang berujung pada bangun **belah ketupat (*diamond keyframe*)**—simbol universal dalam timeline animasi dan kurva vektor untuk menandai *keyframe* dan presisi *frame-perfect*.

---

## 2. Mengapa Desain Ini Dipilih?

Sebuah logo untuk *developer tool* & *creative studio* harus memenuhi tuntutan fungsional di antarmuka pengguna (UI), bukan sekadar estetika di ukuran besar:

- **Keterbacaan Ekstrem di Ukuran Kecil (`16×16px` & `29×29px`)**:
  Logo hanya tersusun dari **4 primitif geometri** (1 tangkai lengkung, 1 daun solid, 1 cabang handle, dan 1 node keyframe) di atas kanvas `24×24`. Jarak *negative space* antara tangkai kiri, daun tengah, dan cabang keyframe dijaga agar tidak menyatu (*muddy*) ketika dirender sebagai *favicon* tab browser (`16×16px`) maupun *header badge* aplikasi (`29×29px`).
- **Keseimbangan Garis (*Stroke*) dan Bidang (*Solid Shape*)**:
  Jika seluruhnya berupa garis tipis, logo akan kehilangan bobot visual di ukuran kecil. Sebaliknya, jika seluruhnya berupa blok padat, nuansa *vector path / tweening* akan hilang. Helai daun solid bertindak sebagai jangkar fokus mata (*visual focal point*), sementara tangkai dan node keyframe memberikan karakter teknis animasi.
- **Adaptif terhadap Tema (`currentColor`)**:
  Karena dibangun dengan geometri satu warna (*monochrome glyph*), logo dapat mewarisi `currentColor` secara langsung—tampil tajam dengan tinta gelap (`#181323`) di atas *badge* ungu lavender khas Ritween (`#baa5ff` pada mode gelap dan `#a894ee` pada mode terang).

---

## 3. Anatomi Geometri (Grid `24×24`)

| Elemen | Representasi | Spesifikasi SVG |
| :--- | :--- | :--- |
| **Tangkai Utama (*Main Stem*)** | Pondasi kode sumber & lintasan kurva awal | `path` (`M6 20V10.5C6 6.91 8.91 4 12.5 4H13.5`), `stroke-width="2.4"`, `stroke-linecap="round"` |
| **Helai Daun Solid (*Leaf Blade*)** | Bentuk visual yang tumbuh dari kurva interpolasi | `path` (`M20 5C20 10.8 15.5 15 10 15C10 9.2 14.5 5 20 5Z`), `fill="currentColor"` |
| **Cabang Handle (*Tween Branch*)** | Garis kontrol tangen / *in-betweening* | `path` (`M11 14.5L16.2 18.8`), `stroke-width="2.4"`, `stroke-linecap="round"` |
| **Node Keyframe (*Diamond Node*)** | Titik *keyframe* / *anchor point* yang presisi | `rect` (`4.4×4.4`, `rx="0.9"`, rotasi `45°` di titik `(17, 18.8)`), `fill="currentColor"` |

---

## 4. Lokasi Penggunaan di Proyek

- **Favicon Aplikasi**: [`public/favicon.svg`](public/favicon.svg) (menggunakan kanvas `32×32` dengan latar *rounded rect* `rx="8"` berwarna `#baa5ff` dan *glyph* `#181323`).
- **HTML Entry Point**: [`index.html`](index.html) (`<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`).
- **Studio Preview Header**: [`src/preview/layout/studio-header.tsx`](src/preview/layout/studio-header.tsx) (dirender sebagai *inline SVG* berukuran `19×19px` di dalam *badge* `29×29px` `bg-primary text-brand-ink`).
