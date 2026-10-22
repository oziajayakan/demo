# Sistem Analisis Kulit Wajah & Validasi Klinis Dermatologi (Skripsi / Tugas Akhir)

Sistem analisis tipe kulit dan masalah kulit wajah berbasis Deep Learning (MobileNetV3 ONNX Runtime Web) yang dilengkapi **Mode Penelitian**, **Portal Penilaian Dokter Spesialis Kulit (Blind Review)**, dan **Halaman Hasil Validasi & Akurasi Otomatis**.

---

## 🚀 Fitur Utama

1. **Mode Penelitian Responden (`/`)**:
   - Lembar persetujuan (*informed consent*) wajib sebelum pemindaian.
   - Formulir kode/inisial responden, usia, gender, dan kondisi pencahayaan.
   - Otomatis menyimpan snapshot frame inferensi, probabilitas AI, dan metadata ke server lokal yang aman setelah verifikasi wajah.
   - Opsi *"Hapus data sampel saya"* untuk hak penarikan/penghapusan data responden sewaktu-waktu.
   - Menjaga seluruh verifikasi liveness dan disclaimer *"bukan diagnosis medis"*.

2. **Portal Penilaian Dokter Spesialis Kulit (`/dokter`)**:
   - Autentikasi dokter via cookie `httpOnly` aman (nama, nomor STR/SIP, instansi, password bcrypt).
   - Antrean sampel acak dengan protokol **Blind Review** murni (hasil AI disembunyikan sepenuhnya dari respons API dan tampilan untuk mencegah bias).
   - Penilaian kualitas foto (Baik / Cukup / Tidak dapat dinilai), diagnosis tipe kulit (*single select*), dan masalah kulit (*multi select*).
   - Satu dokter hanya dapat menilai satu sampel satu kali. Mendukung multi-dokter untuk uji kesepakatan (*inter-rater agreement*).

3. **Halaman Hasil Validasi & Akurasi (`/validasi`)**:
   - Perhitungan otomatis metrik statistik dari ground truth dokter nyata:
     - Akurasi keseluruhan tipe kulit + **Wilson 95% Confidence Interval**.
     - **Cohen's Kappa** (AI vs Dokter dan Antar-Dokter).
     - **Confusion Matrix 4x4** dan metrik per kelas (*Precision*, *Recall*, *F1-Score*).
     - Sensitivitas, spesifisitas, presisi, dan F1 untuk masing-masing masalah kulit (biner).
     - Modul adjudikasi jika terdapat perbedaan diagnosis antar-dokter pada sampel yang sama.
   - **Narasi ringkasan ilmiah otomatis dan objektif** (tanpa klaim berlebihan).
   - Ekspor data mentah ke berkas **CSV** siap olah.

---

## 🛠️ Persyaratan Sistem

- [Node.js](https://nodejs.org/) (versi 18 ke atas)

---

## 📦 Panduan Instalasi & Menjalankan

### 1. Instal Dependensi
Jalankan di root repositori:
```bash
npm install
```

### 2. Menjalankan Server Aplikasi
Jalankan satu perintah berikut:
```bash
npm start
```
*(Atau `node server/index.js`)*

Aplikasi akan aktif di port 3000:
- **Scan & Mode Penelitian**: [http://localhost:3000/](http://localhost:3000/)
- **Penilaian Dokter**: [http://localhost:3000/dokter](http://localhost:3000/dokter)
- **Hasil Validasi**: [http://localhost:3000/validasi](http://localhost:3000/validasi)

---

## 👨‍⚕️ Panduan Manajemen Dokter Penilai

### Menambahkan Akun Dokter Baru (CLI)
Gunakan skrip CLI interaktif:
```bash
npm run add-doctor
```
Atau berikan langsung sebagai argumen:
```bash
npm run add-doctor "dr. Nama Lengkap, Sp.D.V.E" "STR-123456" "RSUD Dr. Soetomo" "password123"
```
*(Atau `node bin/add-doctor.js "..." "..." "..." "..."`)*

Akun langsung terenkripsi dengan aman dan siap digunakan login di [http://localhost:3000/dokter](http://localhost:3000/dokter).

---

## 🧪 Data Uji & Pengujian Metrik (Testing)

### 1. Menjalankan Unit Test Metrik Statistik
Untuk memverifikasi kebenaran perhitungan statistik (Wilson Score, Cohen's Kappa, Confusion Matrix, Sensitivity/Specificity):
```bash
npm test
```
*(Atau `node test/metrics.test.js`)*

### 2. Memasukkan Data Uji Coba (Seed Dummy Data)
Untuk mencoba alur tanpa harus melakukan scan wajah manual puluhan kali:
```bash
npm run seed-dummy
```
*(Atau `node bin/seed-dummy.js`)*

Skrip ini akan membuat:
- **dr. Indah Permata, Sp.D.V.E [DUMMY]** (STR: `STR-991203-DUMMY`, password: `dokter123`)
- **dr. Budi Santoso, Sp.KK [DUMMY]** (STR: `STR-884192-DUMMY`, password: `dokter123`)
- 10 sampel dummy dengan variasi tipe dan masalah kulit untuk menguji confusion matrix, kappa, multi-dokter, dan adjudikasi.

---

## 📊 Ekspor Data Hasil Penelitian

1. Buka halaman [http://localhost:3000/validasi](http://localhost:3000/validasi).
2. Klik tombol **"📥 Ekspor Data Lengkap (CSV)"** di pojok kanan atas.
3. Berkas `data_validasi_skripsi.csv` akan otomatis terunduh berisi detail responden, prediksi AI, penilaian dokter, dan waktu penilaian tanpa menyertakan berkas foto fisik (menjaga privasi).

---

## 📁 Struktur Direktori Penelitian

```
├── bin/
│   ├── add-doctor.js       # CLI penambahan akun dokter
│   └── seed-dummy.js       # CLI seed data dummy pengujian
├── data/
│   ├── photos/             # Folder foto sampel wajah (UUID)
│   └── skripsi_validation.db # Basis data SQLite (better-sqlite3)
├── demoweb/
│   ├── index.html          # Scan wajah + Mode Penelitian (Informed Consent)
│   ├── dokter.html         # Portal blind review dokter spesialis
│   ├── validasi.html       # Dasbor hasil validasi klinis & metrik akurasi
│   ├── labels.json         # Konfigurasi model ONNX & threshold
│   └── skin_model.onnx     # Bobot model ONNX MobileNetV3
├── server/
│   ├── app.js              # Express routing & REST API endpoint
│   ├── db.js               # Inisialisasi basis data SQLite
│   ├── index.js            # Entry point server Express (Port 3000)
│   └── metrics.js          # Modul perhitungan statistik (Wilson, Kappa, Matrix)
├── test/
│   └── metrics.test.js     # Unit test rumus metrik validasi
└── package.json
```
