// server/db.js
// Inisialisasi basis data SQLite dan pembuatan skema tabel penelitian & validasi
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Pastikan direktori data dan photos tersedia
const dataDir = path.join(__dirname, '..', 'data');
const photosDir = path.join(dataDir, 'photos');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

const dbPath = path.join(dataDir, 'skripsi_validation.db');
const db = new Database(dbPath);

// Aktifkan foreign key dan mode WAL untuk performa lokal yang stabil
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Buat skema tabel sesuai spesifikasi kebutuhan penelitian
db.exec(`
  CREATE TABLE IF NOT EXISTS respondents (
    id TEXT PRIMARY KEY,
    kode TEXT UNIQUE NOT NULL,
    usia INTEGER,
    jenis_kelamin TEXT,
    cahaya TEXT,
    consent_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS samples (
    id TEXT PRIMARY KEY,
    respondent_id TEXT NOT NULL,
    photo_file TEXT NOT NULL,
    model_version TEXT DEFAULT 'v1.0-onnx',
    ai_type_probs TEXT NOT NULL,       -- JSON array probabilitas tipe kulit
    ai_concern_probs TEXT NOT NULL,    -- JSON array probabilitas masalah kulit
    ai_type TEXT NOT NULL,             -- Kelas prediksi AI teratas (misal: "berminyak")
    ai_concerns TEXT NOT NULL,         -- JSON array masalah terdeteksi (misal: ["jerawat", "kemerahan"])
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(respondent_id) REFERENCES respondents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS doctors (
    id TEXT PRIMARY KEY,
    nama TEXT NOT NULL,
    str_sip TEXT NOT NULL,
    instansi TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    sample_id TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    kualitas TEXT NOT NULL,             -- 'Baik' | 'Cukup' | 'Tidak dapat dinilai'
    tipe_kulit TEXT,                    -- 'normal' | 'berminyak' | 'kering' | 'kombinasi' (null jika tidak dapat dinilai)
    masalah TEXT,                       -- JSON array masalah pilihan dokter
    catatan TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sample_id, doctor_id),
    FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE,
    FOREIGN KEY(doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS adjudications (
    id TEXT PRIMARY KEY,
    sample_id TEXT UNIQUE NOT NULL,
    decided_by TEXT NOT NULL,          -- Admin atau dokter ke-3
    tipe_kulit TEXT NOT NULL,
    masalah TEXT,
    catatan TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
  );
`);

module.exports = {
  db,
  dataDir,
  photosDir
};
