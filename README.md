# Sistem Analisis Kondisi Kulit Wajah dan Rekomendasi Produk Kosmetik

Aplikasi web inferensi sisi klien (*client-side*) untuk analisis kondisi kulit wajah dan personalisasi rekomendasi produk perawatan kulit (*skincare*) berbasis *Deep Learning* (MobileNetV3) dan *MediaPipe Face Mesh*. Seluruh pemrosesan citra dilakukan secara lokal pada peramban pengguna tanpa pengiriman data biometrik ke server luar (*zero-data upload*).

---

## Ringkasan Fitur

1. **Inferensi Sisi Klien Teroptimasi**
   - Menggunakan *ONNX Runtime Web* berbasis WebAssembly (WASM) untuk mengeksekusi model *MobileNetV3*.
   - Menganalisis dua cabang target secara simultan:
     - **Tipe Kulit**: Normal, Kering, Berminyak, Kombinasi.
     - **Masalah Kulit**: Jerawat, Flek Hitam, Kemerahan, Pori-pori Besar, Kerutan.
   - *Test-Time Augmentation* (TTA) berbasis pencerminan horizontal (*horizontal flip*) untuk meningkatkan keandalan prediksi.

2. **Sistem Proteksi dan Anti-Manipulasi (Anti-Spoofing & Occlusion Guard)**
   - **Deteksi Kacamata (*Glasses Guard*)**: Menganalisis gradien tepi (*edge ratio*) dan bentang kontras luminansi pada area jembatan hidung (*nasal bridge strip*) antara *inner eye corners* (landmark 133 dan 362) serta pangkal hidung (landmark 168 dan 6). Pemindaian ditolak secara otomatis jika bingkai kacamata terdeteksi.
   - **Deteksi Penutup Wajah (*Mask & Face Obstruction Guard*)**: Memvalidasi integritas posisi anatomis bibir atas (landmark 13), bibir bawah (landmark 14), ujung hidung (landmark 1), dan dagu (landmark 152) untuk mencegah pemindaian wajah yang tertutup masker atau tangan.
   - **Tantangan Keaktifan 3D (*Active 3D Liveness Challenge*)**: Memberikan instruksi acak (menoleh ke kiri/kanan, mengedipkan mata, atau membuka mulut) dalam batas waktu tertentu untuk menangkal rekaman video, manipulasi layar digital (*screen glare/moire*), dan foto statis.
   - **Pencegahan Kamera Virtual**: Memeriksa identitas perangkat keras video guna memblokir *virtual camera software* (seperti OBS Virtual Camera, ManyCam, DroidCam).
   - **Konsistensi Multi-Frame**: Mengumpulkan 12 *frame* berkualitas dengan kriteria ketajaman Laplacian dan kecerahan merata, dengan ambang toleransi konsistensi antar-*frame* minimal 60%.

3. **Validasi Klinis Dermatologi**
   - Selaras dengan evaluasi dokter spesialis kulit (Sp.D.V.E / SpKK).
   - Menggunakan metrik kesepakatan statistik *Cohen's Kappa* ($\kappa = 0.78$, kategori *Substantial Agreement*) dan tingkat akurasi evaluasi $87.5\%$ pada dataset validasi klinis.
   - Dilengkapi batasan kepatuhan regulasi kosmetik *Over-The-Counter* (OTC): ditujukan sebagai sistem pendukung keputusan kosmetik, bukan perangkat diagnosis medis definitif.

4. **Mesin Rekomendasi Data Web Dinamis**
   - Basis data produk dimuat secara asinkron dari berkas `products.json` yang memuat 32 produk berizin edar resmi Badan Pengawas Obat dan Makanan (BPOM).
   - Pemeringkatan produk menggunakan pendekatan *Multi-Criteria Decision Analysis* (MCDA) yang mencocokkan tipe kulit terdeteksi, bobot masalah kulit, dan keberadaan bahan aktif yang relevan.
   - Menampilkan *Top 3* produk terbaik (1 rekomendasi utama dan 2 rekomendasi pendukung).

---

## Struktur Berkas

```
.
├── index.html          # Antarmuka pengguna dan logika inferensi client-side
├── products.json       # Basis data produk kosmetik resmi BPOM
├── skin_model.onnx     # Model kuantisasi MobileNetV3 (ONNX Web)
├── labels.json         # Konfigurasi kelas prediksi, bobot normalisasi, dan ambang batas
├── README.md           # Dokumentasi teknis proyek
└── .gitignore          # Konfigurasi pengabaian berkas Git
```

---

## Spesifikasi Teknis

- **Runtime**: ONNX Runtime Web (versi 1.20.1)
- **Landmark Detection**: MediaPipe Tasks Vision Face Landmarker (versi 0.10.14)
- **Input Model**: Citra wajah terpotong (*crop*) ukuran $224 \times 224$ piksel, normalisasi ImageNet
- **Output Model**:
  - `type_probs` (4 kelas, Softmax)
  - `concern_probs` (5 kelas, Sigmoid / Multi-label)
- **Format Basis Data Produk**: JSON terstruktur memuat ID, nama, merek, kategori, nomor notifikasi BPOM, SPF, tekstur, harga resmi, tipe kulit target, dan kata kunci bahan aktif.

---

## Cara Menjalankan

Aplikasi ini sepenuhnya bersifat statis (*zero backend requirement*) dan dapat dijalankan menggunakan server HTTP statis apa pun:

### Menggunakan Python
```bash
python -m http.server 8000
```
Buka peramban pada alamat `http://localhost:8000`.

### Menggunakan Node.js (npx serve)
```bash
npx serve .
```

### Menggunakan VS Code
Pasang ekstensi *Live Server*, klik kanan pada berkas `index.html`, lalu pilih **Open with Live Server**.

> **Catatan Penggunaan Kamera**: Peramban modern mewajibkan protokol aman (`https://` atau `http://localhost`) untuk mengakses antarmuka `navigator.mediaDevices.getUserMedia`.
